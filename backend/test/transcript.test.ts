import { expect, test } from "vitest";
import { completeLines } from "../src/transcript";

test("completeLines leaves a half-written last line for the next read", () => {
	expect(completeLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], count: 2 });
	expect(completeLines('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], count: 1 });
	expect(completeLines("")).toEqual({ lines: [], count: 0 });
	expect(completeLines("x\n\ny\n")).toEqual({ lines: ["x", "y"], count: 3 });
});
