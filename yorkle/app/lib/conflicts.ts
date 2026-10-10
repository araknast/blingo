// Git conflict markers in a file, split into plain text and conflicts ("ours" = the bubble the ferge
// kept, "theirs" = the one it absorbed). A diff3 base section (|||||||) is dropped. Lines keep their
// "\n", so joining the parts back gives the file.
export type Part = { text: string } | { ours: string; theirs: string; oursLabel: string; theirsLabel: string };
export type Choice = "ours" | "theirs" | "both" | { custom: string };

export const hasConflicts = (text: string) => /^<{7}( |$)/m.test(text);

export function parseConflicts(text: string): Part[] {
	const parts: Part[] = [];
	let plain = "";
	let c: { ours: string; theirs: string; oursLabel: string; theirsLabel: string; side: "ours" | "base" | "theirs" } | null = null;
	for (const line of text.split(/(?<=\n)/)) {
		const marker = line.match(/^(<{7}|\|{7}|={7}|>{7})(?: (.*?))?\r?\n?$/);
		if (!c) {
			if (marker?.[1] === "<<<<<<<") {
				if (plain) parts.push({ text: plain }), (plain = "");
				c = { ours: "", theirs: "", oursLabel: marker[2] ?? "", theirsLabel: "", side: "ours" };
			} else plain += line;
		} else if (marker?.[1] === "|||||||" && c.side === "ours") c.side = "base";
		else if (marker?.[1] === "=======" && c.side !== "theirs") c.side = "theirs";
		else if (marker?.[1] === ">>>>>>>" && c.side === "theirs") {
			parts.push({ ours: c.ours, theirs: c.theirs, oursLabel: c.oursLabel, theirsLabel: marker[2] ?? "" });
			c = null;
		} else if (c.side === "ours") c.ours += line;
		else if (c.side === "theirs") c.theirs += line;
	}
	// An unterminated conflict stays as it was written.
	if (c) plain += `<<<<<<< ${c.oursLabel}\n${c.ours}=======\n${c.theirs}`;
	if (plain) parts.push({ text: plain });
	return parts;
}

// The file with each conflict replaced by its choice; null while a conflict has none.
export function resolve(parts: Part[], choices: (Choice | undefined)[]): string | null {
	let out = "";
	let n = 0;
	for (const p of parts) {
		if ("text" in p) {
			out += p.text;
			continue;
		}
		const ch = choices[n++];
		if (ch === undefined) return null;
		out += ch === "ours" ? p.ours : ch === "theirs" ? p.theirs : ch === "both" ? p.ours + p.theirs : ch.custom;
	}
	return out;
}
