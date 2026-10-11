// A Svelte action for a log <pre>: open it scrolled to its first failure, not at the top of a page of
// passing lines.
export function atFailure(el: HTMLElement) {
	const lines = el.textContent?.split("\n") ?? [];
	const i = lines.findIndex((x) => /\b(FAIL|FAILED|Error|ERR!)\b|✗|✕|failed/.test(x));
	if (i > 2) el.scrollTop = Math.max(0, (i - 2) * (parseFloat(getComputedStyle(el).lineHeight) || 18));
}
