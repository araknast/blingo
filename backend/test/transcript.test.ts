import { expect, test } from "vitest";
import { NO_USAGE, completeLines, usageFromBody } from "../src/transcript";

test("usageFromBody reads a Messages stream's usage, wherever the provider puts the input counts", () => {
	const sse = (start: object, delta: object) =>
		["event: message_start", `data: ${JSON.stringify({ type: "message_start", message: { usage: start } })}`, "", 'data: {"type":"ping"}', "", `data: ${JSON.stringify({ type: "message_delta", usage: delta })}`, ""].join("\n");
	expect(usageFromBody(sse({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 7, output_tokens: 1 }, { output_tokens: 42 }))).toEqual({ input: 10, output: 42, cacheRead: 500, cacheWrite: 7 });
	expect(usageFromBody(sse({ input_tokens: 0, output_tokens: 0 }, { input_tokens: 30, output_tokens: 5, cache_read_input_tokens: null }))).toEqual({ input: 30, output: 5, cacheRead: 0, cacheWrite: 0 });
	expect(usageFromBody(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }))).toEqual({ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 });
	expect(usageFromBody('{"input_tokens": 9}')).toEqual(NO_USAGE); // count_tokens: not a generation
});

test("completeLines leaves a half-written last line for the next read", () => {
	expect(completeLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({ lines: ['{"a":1}', '{"b":2}'], count: 2 });
	expect(completeLines('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], count: 1 });
	expect(completeLines("")).toEqual({ lines: [], count: 0 });
	expect(completeLines("x\n\ny\n")).toEqual({ lines: ["x", "y"], count: 3 });
});
