// Syntax highlighting, loaded on first use. Returns one HTML string per line.

let hljs: typeof import("highlight.js").default | undefined;

const ALIASES: Record<string, string> = { mjs: "javascript", cjs: "javascript", jsonc: "json", svelte: "xml", vue: "xml", toml: "ini", tsx: "typescript", jsx: "javascript" };

export function language(path: string) {
	const name = path.split("/").pop()!.toLowerCase();
	if (name === "dockerfile") return "dockerfile";
	if (name === "makefile") return "makefile";
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	return ALIASES[ext] ?? ext;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function highlightLines(text: string, path: string): Promise<string[]> {
	const lang = language(path);
	let html = escape(text);
	if (lang && text.length < 300_000) {
		hljs ??= (await import("highlight.js/lib/common")).default;
		if (hljs.getLanguage(lang)) html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
	}
	return splitLines(html);
}

export const plainLines = (text: string) => splitLines(escape(text));

// Split highlighted HTML on newlines, closing and reopening spans that cross a line break.
export function splitLines(html: string): string[] {
	const lines: string[] = [];
	const open: string[] = [];
	let cur = "";
	for (const tok of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+/g) ?? []) {
		if (tok === "\n") {
			lines.push(cur + "</span>".repeat(open.length));
			cur = open.join("");
		} else {
			if (tok.startsWith("<span")) open.push(tok);
			else if (tok === "</span>") open.pop();
			cur += tok;
		}
	}
	if (cur !== open.join("") || !lines.length) lines.push(cur + "</span>".repeat(open.length));
	return lines;
}
