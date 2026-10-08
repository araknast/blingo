import { expect, test } from "vitest";
import { diffTrees, resolvePath, type TreeEntry } from "../src/git";

const store: Record<string, TreeEntry[]> = {
	root1: [{ name: "a.txt", type: "blob", hash: "a1" }, { name: "keep", type: "tree", hash: "k" }, { name: "src", type: "tree", hash: "src1" }],
	src1: [{ name: "gone.ts", type: "blob", hash: "g" }, { name: "x.ts", type: "blob", hash: "x1" }],
	root2: [{ name: "a.txt", type: "blob", hash: "a2" }, { name: "keep", type: "tree", hash: "k" }, { name: "src", type: "tree", hash: "src2" }],
	src2: [{ name: "new.ts", type: "exec", hash: "n" }, { name: "x.ts", type: "blob", hash: "x1" }],
	r3: [{ name: "src", type: "blob", hash: "s" }],
};
let reads: string[] = [];
const readTree = async (h: string) => (reads.push(h), store[h] ?? null);

test("diffTrees lists changed files and skips equal subtrees", async () => {
	reads = [];
	expect(await diffTrees(readTree, "root1", "root2")).toEqual([
		{ path: "a.txt", status: "modified", oldHash: "a1", newHash: "a2" },
		{ path: "src/gone.ts", status: "removed", oldHash: "g", newHash: null },
		{ path: "src/new.ts", status: "added", oldHash: null, newHash: "n" },
	]);
	expect(reads).not.toContain("k");
});

test("diffTrees from nothing adds every file", async () => {
	expect((await diffTrees(readTree, null, "root1")).map((c) => c.path)).toEqual(["a.txt", "src/gone.ts", "src/x.ts"]);
});

test("a file replaced by a directory is a removal plus additions", async () => {
	expect(await diffTrees(readTree, "r3", "root1")).toEqual([
		{ path: "a.txt", status: "added", oldHash: null, newHash: "a1" },
		{ path: "src/gone.ts", status: "added", oldHash: null, newHash: "g" },
		{ path: "src/x.ts", status: "added", oldHash: null, newHash: "x1" },
		{ path: "src", status: "removed", oldHash: "s", newHash: null },
	]);
});

test("resolvePath walks the tree", async () => {
	expect(await resolvePath(readTree, "root1", "")).toEqual({ name: "", type: "tree", hash: "root1" });
	expect(await resolvePath(readTree, "root1", "src/x.ts")).toEqual({ name: "x.ts", type: "blob", hash: "x1" });
	expect(await resolvePath(readTree, "root1", "a.txt/nope")).toBeNull();
	expect(await resolvePath(readTree, "root1", "missing")).toBeNull();
});
