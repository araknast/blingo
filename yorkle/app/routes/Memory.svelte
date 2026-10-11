<script lang="ts">
	// The repository's memory items: every agent and superagent reads them, and can add its own.
	import { onDestroy } from "svelte";
	import { isRun } from "../lib/attention";
	import Markdown from "../lib/Markdown.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { markMemorySeen, memorySeen } from "../lib/seen";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import { ago, compact, repoName, runId, runKind } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 5000);
	// Notes agents wrote since this browser last looked are marked new; looking now counts as seen.
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const seen = memorySeen(repo);
	// svelte-ignore state_referenced_locally
	markMemorySeen(repo);
	onDestroy(() => markMemorySeen(repo));

	// Deleting waits a few seconds so it can be undone; meanwhile the note is hidden.
	let deleting = $state<string[]>([]);
	const all = $derived([...(rd.data?.memory ?? [])].reverse().filter((m) => !deleting.includes(m.id))); // newest first
	let who = $state<"all" | "people" | "agents">("all");
	let query = $state("");
	const items = $derived(
		all.filter((m) => who === "all" || (who === "agents") === isRun(m.author)).filter((m) => !query.trim() || m.text.toLowerCase().includes(query.trim().toLowerCase())),
	);
	let page = $state(0);
	$effect(() => {
		who;
		query;
		page = 0;
	});
	// Deleting the last note on a page steps back.
	const shown = $derived(items.slice(Math.min(page, Math.max(0, Math.ceil(items.length / PAGE) - 1)) * PAGE).slice(0, PAGE));
	// Roughly what the notes add to every prompt (about four characters a token).
	const tokens = $derived(Math.round(all.reduce((n, m) => n + m.text.length, 0) / 4));

	let note = $state("");
	let busy = $state(false);
	async function add(e: Event) {
		e.preventDefault();
		if (!note.trim()) return;
		busy = true;
		try {
			await api("POST", `/repos/${repo}/memory`, { text: note });
			note = "";
			toast("Note added. Agents already running get it too");
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	function remove(id: string) {
		deleting = [...deleting, id];
		timers.set(
			id,
			setTimeout(async () => {
				timers.delete(id);
				try {
					await api("DELETE", `/repos/${repo}/memory/${id}`);
					await rd.refresh();
				} catch (err) {
					toastError(err);
				}
				deleting = deleting.filter((x) => x !== id);
			}, 6000),
		);
		toast("Note deleted", false, { label: "Undo", run: () => (clearTimeout(timers.get(id)), timers.delete(id), (deleting = deleting.filter((x) => x !== id))) });
	}
	// Leaving the page still deletes what was deleted.
	onDestroy(() => {
		for (const [id, t] of timers) (clearTimeout(t), api("DELETE", `/repos/${repo}/memory/${id}`).catch(() => {}));
	});
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Memory" }]}
	{repo}
	data={rd.data}
>
	<div class="page">
		<h1>Memory</h1>
		<p class="lede">
			Every agent working on this repository reads these notes, including ones already running, and can add its own.
			{#if all.length}<span class="cost">{all.length} {all.length === 1 ? "note" : "notes"}, about {compact(tokens)} tokens in every prompt.</span>{/if}
		</p>
		<form class="add" onsubmit={add}>
			<label for="new-note" class="visually-hidden">New note</label>
			<textarea
				id="new-note"
				rows="2"
				bind:value={note}
				placeholder="A fact every agent should know, like a convention or a gotcha. Markdown works."
				required
				maxlength="500"
				onkeydown={(e) => (e.ctrlKey || e.metaKey) && e.key === "Enter" && add(e)}
			></textarea>
			<div class="add-foot">
				<span class="count" class:full={note.length > 450}>{note.length}/500</span>
				<button class="primary" disabled={busy || !note.trim()}>Add note</button>
			</div>
		</form>
		{#if !rd.data}
			<p class="muted">Loading…</p>
		{:else if !all.length}
			<p class="muted">No notes yet.</p>
		{:else}
			<div class="toolbar">
				<div class="chips" role="group" aria-label="Written by">
					<button aria-pressed={who === "all"} onclick={() => (who = "all")}>All</button>
					<button aria-pressed={who === "people"} onclick={() => (who = "people")}>By people</button>
					<button aria-pressed={who === "agents"} onclick={() => (who = "agents")}>By agents</button>
				</div>
				<input type="search" bind:value={query} placeholder="Find in notes" aria-label="Find in notes" />
			</div>
			{#if !items.length}
				<p class="muted">No note matches.</p>
			{:else}
				<ul class="notes">
					{#each shown as m (m.id)}
						{@const fresh = isRun(m.author) && m.created > seen}
						<li class:fresh>
							<div class="text"><Markdown text={m.text} /></div>
							<span class="by">
								{#if fresh}<span class="badge new">New</span>{/if}
								<span>{#if isRun(m.author)}<a href="/repos/{repo}/agents/{m.author}">{runKind({ fork: m.author })} <span class="mono">{runId(m.author)}</span></a>{:else}{m.author}{/if}, {ago(m.created)}</span>
							</span>
							<button class="quiet" aria-label="Delete the note: {m.text.slice(0, 50)}" onclick={() => remove(m.id)}>Delete</button>
						</li>
					{/each}
				</ul>
				<Pager bind:page total={items.length} />
			{/if}
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 52rem; }
	.lede { margin: 0.4rem 0 1.25rem; color: var(--ink-2); max-width: 65ch; }
	.cost { display: block; margin-top: 0.25rem; color: var(--ink); }
	.add { display: grid; gap: 0.4rem; margin-bottom: 1.5rem; }
	.add textarea { min-height: 4.5rem; resize: vertical; }
	.add-foot { display: flex; justify-content: space-between; align-items: center; }
	.count { font-size: 0.8125rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }
	.count.full { color: var(--conflict); }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin-bottom: 0.75rem; }
	.toolbar input { width: 14rem; max-width: 100%; }
	.notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.notes li { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; padding: 0.6rem 1rem 0.75rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	.notes li.fresh { border-color: color-mix(in srgb, var(--working) 45%, var(--line)); }
	.text { min-width: 0; overflow-wrap: anywhere; }
	.text :global(.md) { padding: 0; }
	.text :global(.md > :first-child) { margin-top: 0; }
	.text :global(.md > :last-child) { margin-bottom: 0; }
	.by { font-size: 0.8125rem; color: var(--ink-3); display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.by a { color: var(--ink-2); }
	.badge.new { color: var(--working); border-color: currentColor; }
	.notes button { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
</style>
