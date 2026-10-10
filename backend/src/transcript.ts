// Splits a chunk read from a growing JSONL file into complete lines. A trailing line with no newline
// may still be mid-write, so it is left for the next read; `count` is how far the line cursor advances.
export function completeLines(raw: string): { lines: string[]; count: number } {
	const parts = raw.split("\n");
	parts.pop();
	return { lines: parts.filter(Boolean), count: parts.length };
}
