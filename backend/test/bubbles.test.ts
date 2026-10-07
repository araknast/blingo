import { expect, test } from "vitest";
import { conflictKey, distance, nearestNeighbour, placeFork, zeroDistanceJoins, type Bubble } from "../src/bubbles";

const h = (id: string, files: string[], visible = true): Bubble => ({ id, files: new Set(files), visible });

test("distance counts shared files", () => {
	expect(distance(h("a", ["x", "y"]), h("b", ["y", "z"]))).toBe(1);
	expect(distance(h("a", ["x"]), h("b", ["z"]))).toBe(0);
});

test("disjoint fork joins first visible bubble, overlapping fork gets a new one", () => {
	const hs = [h("a", ["x"]), h("b", ["y"])];
	expect(placeFork(hs, ["z"])).toBe("a");
	expect(placeFork(hs, ["x"])).toBe("b");
	expect(placeFork(hs, ["x", "y"])).toBeNull();
});

test("invisible (merging) bubbles are skipped for placement", () => {
	expect(placeFork([h("a", ["x"], false), h("b", ["y"])], ["z"])).toBe("b");
	expect(placeFork([h("a", ["x"], false)], ["z"])).toBeNull();
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
	expect(placeFork([locked], ["y"])).toBe("l");
	expect(zeroDistanceJoins([h("a", ["y"]), locked])).toEqual([]);
	expect(nearestNeighbour("a", [h("a", ["x"]), locked], new Set())).toBeNull();
	expect(nearestNeighbour("l", [locked, h("a", ["x"])], new Set())).toBeNull();
});
