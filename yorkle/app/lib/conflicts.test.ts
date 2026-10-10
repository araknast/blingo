import { expect, test } from "vitest";
import { hasConflicts, parseConflicts, resolve } from "./conflicts";

const FILE = "top\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> abc123\nmiddle\n<<<<<<< HEAD\nA\n||||||| base\nO\n=======\nB\n>>>>>>> abc123\nend\n";

test("conflict markers split into text and conflicts, and join back", () => {
	expect(hasConflicts(FILE)).toBe(true);
	expect(hasConflicts("a <<<<<<< b\n")).toBe(false);
	const parts = parseConflicts(FILE);
	expect(parts).toEqual([
		{ text: "top\n" },
		{ ours: "ours 1\nours 2\n", theirs: "theirs\n", oursLabel: "HEAD", theirsLabel: "abc123" },
		{ text: "middle\n" },
		{ ours: "A\n", theirs: "B\n", oursLabel: "HEAD", theirsLabel: "abc123" }, // diff3 base dropped
		{ text: "end\n" },
	]);
	expect(resolve(parts, ["ours", undefined])).toBeNull();
	expect(resolve(parts, ["theirs", "both"])).toBe("top\ntheirs\nmiddle\nA\nB\nend\n");
	expect(resolve(parts, [{ custom: "mine\n" }, "ours"])).toBe("top\nmine\nmiddle\nA\nend\n");
});

test("no markers, a last line without newline, and an unterminated conflict", () => {
	expect(parseConflicts("plain\n")).toEqual([{ text: "plain\n" }]);
	expect(parseConflicts("<<<<<<< a\nx\n=======\ny\n>>>>>>> b")).toEqual([{ ours: "x\n", theirs: "y\n", oursLabel: "a", theirsLabel: "b" }]);
	expect(resolve(parseConflicts("<<<<<<< a\nx\n=======\ny\n"), [])).toBe("<<<<<<< a\nx\n=======\ny\n");
});
