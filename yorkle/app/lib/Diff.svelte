<script lang="ts">
	import type { StructuredPatchHunk } from "diff";

	let { hunks, split = false }: { hunks: StructuredPatchHunk[]; split?: boolean } = $props();

	type Line = { kind: " " | "+" | "-"; text: string; old?: number; new?: number };
	type Row = { left?: Line; right?: Line };

	// Number each hunk's lines; "\ No newline at end of file" markers are dropped.
	const numbered = $derived(
		hunks.map((h) => {
			let o = h.oldStart, n = h.newStart;
			const lines: Line[] = [];
			for (const raw of h.lines) {
				const kind = raw[0] as Line["kind"];
				if (kind === "+") lines.push({ kind, text: raw.slice(1), new: n++ });
				else if (kind === "-") lines.push({ kind, text: raw.slice(1), old: o++ });
				else if (kind === " ") lines.push({ kind, text: raw.slice(1), old: o++, new: n++ });
			}
			return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines };
		}),
	);

	// Side by side: a run of removals pairs up with the run of additions after it.
	function pair(lines: Line[]): Row[] {
		const rows: Row[] = [];
		for (let i = 0; i < lines.length; ) {
			if (lines[i].kind === " ") {
				rows.push({ left: lines[i], right: lines[i] });
				i++;
				continue;
			}
			const dels: Line[] = [], adds: Line[] = [];
			while (i < lines.length && lines[i].kind === "-") dels.push(lines[i++]);
			while (i < lines.length && lines[i].kind === "+") adds.push(lines[i++]);
			for (let j = 0; j < Math.max(dels.length, adds.length); j++) rows.push({ left: dels[j], right: adds[j] });
		}
		return rows;
	}
	const cls = (l?: Line) => (!l ? "none" : l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx");
</script>

<div class="diff">
	<table class:split>
		{#each numbered as h}
			<tbody>
				<tr class="hunk"><td colspan={split ? 4 : 3}><code>{h.header}</code></td></tr>
				{#if split}
					{#each pair(h.lines) as r}
						<tr>
							<td class="n {cls(r.left)}">{r.left?.old ?? ""}</td>
							<td class="l {cls(r.left)}"><code>{r.left?.text ?? ""}</code></td>
							<td class="n {cls(r.right)} mid">{r.right?.new ?? ""}</td>
							<td class="l {cls(r.right)}"><code>{r.right?.text ?? ""}</code></td>
						</tr>
					{/each}
				{:else}
					{#each h.lines as l}
						<tr class={cls(l)}>
							<td class="n">{l.old ?? ""}</td>
							<td class="n">{l.new ?? ""}</td>
							<td class="l"><code><span class="sign" aria-hidden="true">{l.kind === " " ? " " : l.kind === "+" ? "+" : "−"}</span>{l.text}</code></td>
						</tr>
					{/each}
				{/if}
			</tbody>
		{/each}
	</table>
</div>

<style>
	.diff { overflow-x: auto; background: var(--raised); }
	table { border-collapse: collapse; width: 100%; }
	table.split { table-layout: fixed; }
	table.split .n { width: 3.5rem; }
	td { padding: 0; line-height: 1.375rem; vertical-align: top; }
	.n { width: 1%; min-width: 3rem; padding: 0 0.6rem; text-align: right; font-family: var(--mono); font-size: 0.75rem; color: var(--ink-3); user-select: none; }
	.l { white-space: pre; padding: 0 1rem 0 0.5rem; }
	.split .l { white-space: pre-wrap; word-break: break-all; }
	.l code { font-size: 0.8125rem; }
	.sign { display: inline-block; width: 1.25rem; color: var(--ink-3); user-select: none; }
	.add, .add .n, td.add { background: var(--add-bg); }
	.add code, td.add code { color: var(--add-ink); }
	.del, .del .n, td.del { background: var(--del-bg); }
	.del code, td.del code { color: var(--del-ink); }
	td.none { background: repeating-linear-gradient(135deg, transparent 0 6px, var(--line-2) 6px 7px); }
	.mid { border-left: 1px solid var(--line); }
	.hunk td { background: var(--fog); color: var(--ink-3); padding: 0.25rem 1rem; }
	.hunk code { font-size: 0.75rem; }
</style>
