// Splits a chunk read from a growing JSONL file into complete lines. A trailing line with no newline
// may still be mid-write, so it is left for the next read; `count` is how far the line cursor advances.
export function completeLines(raw: string): { lines: string[]; count: number } {
	const parts = raw.split("\n");
	parts.pop();
	return { lines: parts.filter(Boolean), count: parts.length };
}

// Tokens a model response used. `input` counts uncached input only; the cache fields are separate.
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// A Messages API response body (SSE stream or JSON) → its usage. In a stream, `message_start` carries
// the input counts and `message_delta` the final output count; some providers (OpenRouter) put the
// input counts in `message_delta` instead, so each field takes the larger of the two.
export function usageFromBody(body: string): Usage {
	const events: unknown[] = [];
	if (body.trimStart().startsWith("{")) events.push(tryJson(body));
	else for (const l of body.split("\n")) if (l.startsWith("data:")) events.push(tryJson(l.slice(5)));
	const u = { ...NO_USAGE };
	for (const e of events as ({ type?: string; usage?: Raw; message?: { usage?: Raw } } | null)[]) {
		const r = e?.type === "message_start" ? e.message?.usage : e?.usage;
		if (!r) continue;
		u.input = Math.max(u.input, r.input_tokens ?? 0);
		u.output = Math.max(u.output, r.output_tokens ?? 0);
		u.cacheRead = Math.max(u.cacheRead, r.cache_read_input_tokens ?? 0);
		u.cacheWrite = Math.max(u.cacheWrite, r.cache_creation_input_tokens ?? 0);
	}
	return u;
}
type Raw = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

function tryJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
