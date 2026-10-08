<script lang="ts">
	import { highlightLines, plainLines } from "./highlight";

	let { text, path }: { text: string; path: string } = $props();

	let lines = $state<string[]>([]);
	$effect(() => {
		lines = plainLines(text);
		let live = true;
		highlightLines(text, path).then((l) => live && (lines = l));
		return () => (live = false);
	});
</script>

<div class="code" role="region" aria-label="Contents of {path}" tabindex="-1">
	<table>
		<tbody>
			{#each lines as l, i}
				<tr id="L{i + 1}">
					<td class="n"><a href="#L{i + 1}" aria-label="Line {i + 1}">{i + 1}</a></td>
					<td class="l"><code>{@html l || " "}</code></td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.code { overflow-x: auto; background: var(--raised); }
	table { border-collapse: collapse; width: 100%; }
	td { padding: 0; vertical-align: top; line-height: 1.375rem; }
	.n { width: 1%; min-width: 3.5rem; text-align: right; padding: 0 0.75rem 0 1rem; user-select: none; border-right: 1px solid var(--line-2); }
	.n a { font-family: var(--mono); font-size: 0.75rem; color: var(--ink-3); text-decoration: none; }
	.n a:hover { color: var(--ink); }
	.l { padding-left: 1rem; white-space: pre; }
	.l code { font-size: 0.8125rem; }
	tr:target { background: color-mix(in srgb, var(--amber) 30%, transparent); }
</style>
