<script lang="ts">
	// The repository's memory items: every agent and superagent reads them, and can add its own.
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toastError } from "../lib/toast.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import { ago, repoName } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 5000);
	const items = $derived(rd.data?.memory ?? []);
	let page = $state(0);
	// Deleting the last note on a page steps back.
	const shown = $derived(items.slice(Math.min(page, Math.max(0, Math.ceil(items.length / PAGE) - 1)) * PAGE).slice(0, PAGE));

	let note = $state("");
	let busy = $state(false);
	async function add(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", `/repos/${repo}/memory`, { text: note });
			note = "";
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	async function remove(id: string) {
		try {
			await api("DELETE", `/repos/${repo}/memory/${id}`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		}
	}
	// Notes agents leave are authored by their run's id (a fork or superagent run).
	const author = (a: string) => (a.includes("-f-") || a.includes("-s-") ? "an agent" : a);
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Memory" }]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
	activeAgents={rd.data?.agents.filter((a) => a.status === "running").length}
	runningDeploys={rd.data?.deploys.filter((d) => d.status === "running").length}
>
	<div class="page">
		<h1>Memory</h1>
		<p class="muted lede">Every agent working on this repository reads these notes, including ones already running, and can add its own.</p>
		<form class="add" onsubmit={add}>
			<input aria-label="New note" bind:value={note} placeholder="A fact every agent should know, like a convention or a gotcha" required maxlength="500" />
			<button class="primary" disabled={busy}>Add note</button>
		</form>
		{#if rd.data && !items.length}
			<p class="muted">No notes yet.</p>
		{:else}
			<ul class="notes">
				{#each shown as m (m.id)}
					<li>
						<p>{m.text}</p>
						<span class="muted small">{author(m.author)}, {ago(m.created)}</span>
						<button class="quiet" aria-label="Delete note" onclick={() => remove(m.id)}>Delete</button>
					</li>
				{/each}
			</ul>
			<Pager bind:page total={items.length} />
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 52rem; }
	.lede { margin: 0.4rem 0 1.25rem; }
	.add { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
	.add input { flex: 1; min-width: 0; }
	.notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.notes li { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	.notes p { overflow-wrap: anywhere; }
	.notes button { grid-row: 1 / span 2; grid-column: 2; align-self: center; }
	.small { font-size: 0.8125rem; }
</style>
