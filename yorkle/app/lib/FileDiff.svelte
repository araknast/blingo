<script lang="ts">
	import { structuredPatch, type StructuredPatchHunk } from "diff";
	import Diff from "./Diff.svelte";
	import { MAX_SHOWN, blob, isBinary } from "./git";
	import type { Change } from "./types";

	let {
		repo,
		fork,
		change,
		split,
		viewHref,
		id,
	}: { repo: string; fork: string; change: Change; split: boolean; viewHref?: string; id?: string } = $props();

	let open = $state(true);
	let el: HTMLElement;
	let result = $state<{ hunks: StructuredPatchHunk[]; add: number; del: number } | { note: string } | null>(null);

	async function load() {
		const decode = (b: Uint8Array) => new TextDecoder().decode(b);
		try {
			const [a, b] = await Promise.all([
				change.oldHash ? blob(repo, fork, change.oldHash) : new Uint8Array(),
				change.newHash ? blob(repo, fork, change.newHash) : new Uint8Array(),
			]);
			if (isBinary(a) || isBinary(b)) return (result = { note: "Binary file changed." });
			if (a.length + b.length > MAX_SHOWN * 2) return (result = { note: "This file is too large to diff here." });
			const { hunks } = structuredPatch(change.path, change.path, decode(a), decode(b), "", "", { context: 3 });
			const count = (c: string) => hunks.reduce((n, h) => n + h.lines.filter((l) => l[0] === c).length, 0);
			result = { hunks, add: count("+"), del: count("-") };
			if (result.add + result.del > 1500) open = false; // big diffs start collapsed
		} catch (e) {
			result = { note: e instanceof Error ? e.message : String(e) };
		}
	}

	// Fetch only when the file scrolls near the viewport; merge commits can touch many files.
	$effect(() => {
		const io = new IntersectionObserver(
			(es) => {
				if (es.some((e) => e.isIntersecting)) {
					io.disconnect();
					load();
				}
			},
			{ rootMargin: "600px" },
		);
		io.observe(el);
		return () => io.disconnect();
	});

	const label = { added: "Added", removed: "Deleted", modified: "Modified" };
</script>

<section class="file" bind:this={el} {id}>
	<header>
		<button class="quiet toggle" aria-expanded={open} onclick={() => (open = !open)} aria-label="{open ? 'Collapse' : 'Expand'} {change.path}">
			<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class:closed={!open}><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" /></svg>
		</button>
		<span class="status {change.status}">{label[change.status]}</span>
		<code class="path">{change.path}</code>
		{#if result && "hunks" in result}
			<span class="stat"><span class="plus">+{result.add}</span> <span class="minus">−{result.del}</span></span>
		{/if}
		{#if viewHref && change.status !== "removed"}<a class="view" href={viewHref}>View file</a>{/if}
	</header>
	{#if open}
		{#if !result}
			<p class="note">Loading diff</p>
		{:else if "note" in result}
			<p class="note">{result.note}</p>
		{:else if !result.hunks.length}
			<p class="note">{change.status === "added" ? "Empty file added." : "No text changes."}</p>
		{:else}
			<Diff hunks={result.hunks} {split} />
		{/if}
	{/if}
</section>

<style>
	.file { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; background: var(--paper); scroll-margin-top: 5rem; }
	header { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.75rem 0.45rem 0.4rem; border-bottom: 1px solid var(--line); background: var(--paper); flex-wrap: wrap; }
	.toggle { padding: 0.3rem; }
	.toggle svg { transition: transform 150ms; }
	.toggle svg.closed { transform: rotate(-90deg); }
	.path { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--ink); }
	.status { font-size: 0.75rem; font-weight: 500; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
	.status.added { background: var(--add-bg); color: var(--add-ink); }
	.status.removed { background: var(--del-bg); color: var(--del-ink); }
	.stat { font-family: var(--mono); font-size: 0.75rem; }
	.plus { color: var(--add-ink); }
	.minus { color: var(--del-ink); }
	.view { font-size: 0.8125rem; color: var(--ink-2); }
	.note { padding: 0.9rem 1rem; color: var(--ink-3); font-size: 0.875rem; }
</style>
