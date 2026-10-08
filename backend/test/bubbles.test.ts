import { expect, test } from "vitest";
import { conflictKey, distance, fits, nearestNeighbour, parseMerge, renameConflicts, zeroDistanceJoins, type Bubble } from "../src/bubbles";

const h = (id: string, files: string[], visible = true): Bubble => ({ id, files: new Set(files), visible });

test("distance counts shared files", () => {
	expect(distance(h("a", ["x", "y"]), h("b", ["y", "z"]))).toBe(1);
	expect(distance(h("a", ["x"]), h("b", ["z"]))).toBe(0);
});

test("a fork fits a visible bubble whose files it doesn't bring", () => {
	expect(fits(h("a", ["x"]), ["z"])).toBe(true);
	expect(fits(h("a", ["x"]), ["x", "z"])).toBe(false);
	expect(fits(h("a", ["x"], false), ["z"])).toBe(false); // merging → invisible
});

test("zero-distance bubbles are joined, using the running union", () => {
	// a∪b = {x,y} overlaps c on y, so c stays separate; d is disjoint from everything → joins a.
	const joins = zeroDistanceJoins([h("a", ["x"]), h("b", ["y"]), h("c", ["y", "w"]), h("d", ["q"])]);
	expect(joins).toEqual([["a", "b"], ["a", "d"]]);
});

test("B becoming visible at distance 0 to A triggers a join", () => {
	const hs = [h("a", ["x"]), h("b", ["y"], false)];
	expect(zeroDistanceJoins(hs)).toEqual([]);
	hs[1].visible = true; // b's merge with someone else failed
	expect(zeroDistanceJoins(hs)).toEqual([["a", "b"]]);
});

test("nearest neighbour: min distance, skips conflicts and invisible bubbles", () => {
	const hs = [h("a", ["x", "y", "z"]), h("b", ["x", "y"]), h("c", ["z"]), h("d", ["x"], false)];
	expect(nearestNeighbour("a", hs, new Set())).toBe("c");
	expect(nearestNeighbour("a", hs, new Set([conflictKey("c", "a")]))).toBe("b");
	expect(nearestNeighbour("a", hs, new Set([conflictKey("a", "b"), conflictKey("a", "c")]))).toBeNull();
});

test("locked bubbles stay placeable but never join or get picked as neighbours", () => {
	const locked = { ...h("l", ["x"]), locked: true };
	expect(fits(locked, ["y"])).toBe(true);
	expect(zeroDistanceJoins([h("a", ["y"]), locked])).toEqual([]);
	expect(nearestNeighbour("a", [h("a", ["x"]), locked], new Set())).toBeNull();
	expect(nearestNeighbour("l", [locked, h("a", ["x"])], new Set())).toBeNull();
});

test("conflicts of an absorbed bubble move to the bubble that absorbed it", () => {
	const keys = [conflictKey("a", "c"), conflictKey("a", "b"), conflictKey("b", "c"), conflictKey("d", "e")];
	// c absorbed into b: a|c → a|b (already there), b|c disappears, d|e untouched.
	expect(renameConflicts(keys, "c", "b").sort()).toEqual([conflictKey("a", "b"), conflictKey("d", "e")].sort());
});

test("parseMerge reads each source's status and diff in order", () => {
	const out = "== 0 ok\ndiff --git a/x b/x\n+x\n== 1 conflict\ndiff --git a/y b/y\n-y\n== 2 ok\n";
	expect(parseMerge(out)).toEqual([
		{ ok: true, diff: "diff --git a/x b/x\n+x\n" },
		{ ok: false, diff: "diff --git a/y b/y\n-y\n" },
		{ ok: true, diff: "" },
	]);
});
