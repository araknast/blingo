import { expect, test } from "vitest";
import { conflictKey, distance, fergeCandidate, nearestNeighbour, pickPairs, placeFork, renameConflicts, type Bubble, type Table } from "../src/bubbles";

test("auto-ferge picks a conflicting pair whose bubbles are visible, unlocked and idle, older first", () => {
	const h = (id: string, o: Partial<Bubble> = {}): Bubble => ({ id, files: new Set(), visible: true, ...o });
	const hs = [h("old"), h("mid"), h("new"), h("hid", { visible: false }), h("lock", { locked: true })];
	expect(fergeCandidate([conflictKey("new", "old")], hs, new Set())).toEqual(["old", "new"]);
	expect(fergeCandidate([conflictKey("old", "hid"), conflictKey("mid", "lock"), conflictKey("mid", "new")], hs, new Set())).toEqual(["mid", "new"]);
	expect(fergeCandidate([conflictKey("mid", "new")], hs, new Set(["new"]))).toBeNull(); // queued
	expect(fergeCandidate([conflictKey("mid", "gone")], hs, new Set())).toBeNull();
	expect(fergeCandidate([], hs, new Set())).toBeNull();
});

const h = (id: string, files: string[], visible = true): Bubble => ({ id, files: new Set(files), visible });
// A bubble from its members' change tables (seq null = queued, not applied yet).
const b = (id: string, tables: Table[], o: Partial<Bubble> = {}): Bubble => ({
	id,
	visible: true,
	epoch: 0,
	tables,
	files: new Set(tables.flatMap((t) => t.files)),
	...o,
});
const none = new Set<string>();

test("distance counts shared files", () => {
	expect(distance(h("a", ["x", "y"]), h("b", ["y", "z"]))).toBe(1);
	expect(distance(h("a", ["x"]), h("b", ["z"]))).toBe(0);
});

test("a fork of the base repo goes to the first visible bubble that never changed its files", () => {
	const bs = [b("a", [{ files: ["x"], seq: 1 }]), b("c", [{ files: ["y"], seq: 2 }], { visible: false }), b("d", [{ files: ["q"], seq: 3 }])];
	expect(placeFork(bs, ["z"], null, none)).toBe("a");
	expect(placeFork(bs, ["x", "z"], null, none)).toBe("d"); // c is mid-merge
	expect(placeFork(bs, ["x", "q"], null, none)).toBe("new");
});

test("home: a fork goes back to its bubble when only tables already in its basis touch its files", () => {
	const a = b("a", [{ files: ["x"], seq: 1 }, { files: ["y"], seq: 5 }]);
	const basis = { bubble: "a", epoch: 0, seq: 5 };
	expect(placeFork([b("z", []), a], ["x", "y"], basis, a.files)).toBe("a"); // tried before z
});

test("home: a table applied after the basis, or still queued, blocks it", () => {
	const basis = { bubble: "a", epoch: 0, seq: 5 };
	const later = b("a", [{ files: ["x"], seq: 1 }, { files: ["y"], seq: 6 }]);
	expect(placeFork([later], ["y"], basis, later.files)).toBe("new");
	expect(placeFork([later], ["x"], basis, later.files)).toBe("a");
	// queued before the fork was made, but not in its basis (seq is given when applied)
	const queued = b("a", [{ files: ["x"], seq: 1 }, { files: ["y"], seq: null }]);
	expect(placeFork([queued], ["y"], basis, queued.files)).toBe("new");
});

test("home only while the bubble's epoch is the basis's", () => {
	const a = b("a", [{ files: ["x"], seq: 1 }], { epoch: 1 }); // absorbed something since
	expect(placeFork([a], ["x"], { bubble: "a", epoch: 0, seq: 5 }, a.files)).toBe("new");
});

test("elsewhere: neither the bubble nor the basis bubble may have changed its files", () => {
	const a = b("a", [{ files: ["x"], seq: 1 }]);
	const c = b("c", [{ files: ["y"], seq: 2 }]);
	const basis = { bubble: "a", epoch: 0, seq: 0 }; // a's x table came later, so home doesn't fit
	expect(placeFork([a, c], ["x"], basis, a.files)).toBe("new"); // x differs from base in a's code
	expect(placeFork([a, c], ["z"], { bubble: "gone", epoch: 0, seq: 0 }, new Set(["x"]))).toBe("a");
	expect(placeFork([a, c], ["x"], { bubble: "gone", epoch: 0, seq: 0 }, new Set(["w"]))).toBe("c");
});

test("a ferge bubble's forks only go home", () => {
	const l = b("l", [{ files: ["x", "y"], seq: 3 }], { ferge: true, locked: true });
	const basis = { bubble: "l", epoch: 0, seq: 3 };
	expect(placeFork([b("a", []), l], ["x"], basis, l.files)).toBe("l");
	const later = b("l", [{ files: ["x", "y"], seq: 3 }, { files: ["x"], seq: 4 }], { ferge: true, locked: true });
	expect(placeFork([b("a", []), later], ["x"], basis, later.files)).toBeNull();
	expect(placeFork([b("a", []), { ...l, visible: false }], ["x"], basis, l.files)).toBeNull();
});

test("nearest neighbour: min distance, skips conflicts and invisible bubbles", () => {
	const hs = [h("a", ["x", "y", "z"]), h("b", ["x", "y"]), h("c", ["z"]), h("d", ["x"], false)];
	expect(nearestNeighbour("a", hs, new Set())).toBe("c");
	expect(nearestNeighbour("a", hs, new Set([conflictKey("c", "a")]))).toBe("b");
	expect(nearestNeighbour("a", hs, new Set([conflictKey("a", "b"), conflictKey("a", "c")]))).toBeNull();
	expect(nearestNeighbour("a", [h("a", ["x"]), h("q", ["y"])], new Set())).toBe("q"); // distance 0 counts
});

test("parallel merges: disjoint pairs, oldest first, within the cap", () => {
	const hs = [h("a", ["x"]), h("b", ["x"]), h("c", ["y"]), h("d", ["y"]), h("e", ["z"])];
	// a takes its nearest (c, distance 0); b then takes d; e is left with nobody.
	expect(pickPairs(hs, new Set(), 12)).toEqual([["a", "c"], ["b", "d"]]);
	const ids = pickPairs(hs, new Set(), 12).flat();
	expect(new Set(ids).size).toBe(ids.length); // no bubble twice
	expect(pickPairs(hs, new Set(), 1)).toEqual([["a", "c"]]);
	expect(pickPairs(hs, new Set(), 0)).toEqual([]);
});

test("parallel merges skip invisible, locked and conflicting bubbles", () => {
	const locked = { ...h("l", []), locked: true };
	const hs = [h("a", ["x"]), h("hid", [], false), locked, h("b", ["x"]), h("c", ["x"])];
	expect(pickPairs(hs, new Set([conflictKey("a", "b")]), 12)).toEqual([["a", "c"]]);
	expect(pickPairs([h("a", []), h("b", [])], new Set([conflictKey("a", "b")]), 12)).toEqual([]);
});

test("locked bubbles stay placeable but never get picked as neighbours", () => {
	const locked = b("l", [{ files: ["x"], seq: 1 }], { locked: true });
	expect(placeFork([locked], ["y"], null, none)).toBe("l");
	expect(nearestNeighbour("a", [h("a", ["x"]), locked], new Set())).toBeNull();
	expect(nearestNeighbour("l", [locked, h("a", ["x"])], new Set())).toBeNull();
});

test("conflicts of an absorbed bubble move to the bubble that absorbed it", () => {
	const keys = [conflictKey("a", "c"), conflictKey("a", "b"), conflictKey("b", "c"), conflictKey("d", "e")];
	// c absorbed into b: a|c → a|b (already there), b|c disappears, d|e untouched.
	expect(renameConflicts(keys, "c", "b").sort()).toEqual([conflictKey("a", "b"), conflictKey("d", "e")].sort());
});
