<script lang="ts">
	import Dialog from "../lib/Dialog.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import Shell from "../lib/Shell.svelte";
	import { navigate } from "../lib/router.svelte";
	import { api, loadMe, session } from "../lib/session.svelte";
	import { toastError } from "../lib/toast.svelte";
	import type { RepoState } from "../lib/types";
	import { plural, repoName } from "../lib/util";

	let creating = $state(false);
	let filter = $state("");
	let summaries = $state<Record<string, RepoState | "error">>({});

	// ponytail: one request per repository for its summary; add a summary endpoint if lists grow long.
	$effect(() => {
		for (const r of session.me?.repos ?? []) {
			if (r in summaries) continue;
			api<RepoState>("GET", `/repos/${r}`)
				.then((s) => (summaries[r] = s))
				.catch(() => (summaries[r] = "error"));
		}
	});

	const nameOf = (r: string) => repoName(r, session.me?.names);
	const repos = $derived(
		(session.me?.repos ?? [])
			.filter((r) => `${nameOf(r)} ${r}`.toLowerCase().includes(filter.trim().toLowerCase()))
			.toSorted((a, b) => nameOf(a).localeCompare(nameOf(b))),
	);

	let page = $state(0);
	$effect(() => {
		filter;
		page = 0;
	});
	const visible = $derived(repos.slice(page * PAGE, (page + 1) * PAGE));

	let createOpen = $state(false);
	let newName = $state("");
	async function create(e: SubmitEvent) {
		e.preventDefault();
		creating = true;
		try {
			const { repo } = await api<{ repo: string }>("POST", "/repos", { name: newName });
			createOpen = false;
			newName = "";
			await loadMe();
			navigate(`/repos/${repo}`);
		} catch (e) {
			toastError(e);
		} finally {
			creating = false;
		}
	}
</script>

<Shell crumbs={[{ label: "Repositories" }]}>
	{#snippet actions()}
		<button class="primary" onclick={() => (createOpen = true)} disabled={creating}>Create repository</button>
	{/snippet}
	<div class="page">
		<h1>Repositories</h1>
		{#if !session.me?.repos.length}
			<div class="empty">
				<h2>Create your first repository</h2>
				<p>A repository starts empty. Start agents on it or push forks to it, and yorkle groups their work into bubbles.</p>
				<button class="primary" onclick={() => (createOpen = true)} disabled={creating}>Create repository</button>
			</div>
		{:else}
			<div class="tools">
				<label class="visually-hidden" for="filter">Filter repositories</label>
				<input id="filter" type="search" placeholder="Filter by name" bind:value={filter} />
			</div>
			<table>
				<thead>
					<tr><th>Name</th><th>Bubbles</th><th>Agents working</th><th>Conflicts</th></tr>
				</thead>
				<tbody>
					{#each visible as r (r)}
						{@const s = summaries[r]}
						<tr>
							<td><a class="name" href="/repos/{r}">{nameOf(r)}</a>{#if nameOf(r) !== r}<span class="muted id mono">{r}</span>{/if}</td>
							{#if s === "error"}
								<td colspan="3" class="muted">Couldn't load</td>
							{:else if !s}
								<td colspan="3" class="muted">Loading</td>
							{:else}
								{@const working = s.agents.filter((a) => a.status === "running").length}
								<td>{s.bubbles.length}<span class="muted forks">{plural(s.bubbles.reduce((n, b) => n + b.members.length, 0), "fork")}</span></td>
								<td>{#if working}<i class="dot working"></i> {working}{:else}<span class="muted">None</span>{/if}</td>
								<td>{#if s.conflicts.length}<i class="dot conflict"></i> {s.conflicts.length}{:else}<span class="muted">None</span>{/if}</td>
							{/if}
						</tr>
					{:else}
						<tr><td colspan="4" class="muted">No repository matches “{filter}”.</td></tr>
					{/each}
				</tbody>
			</table>
			<Pager bind:page total={repos.length} />
		{/if}
	</div>
</Shell>

<Dialog bind:open={createOpen} title="Create a repository">
	<form onsubmit={create}>
		<div class="field">
			<label for="repo-name">Name</label>
			<input id="repo-name" bind:value={newName} required maxlength="60" placeholder="My project" />
			<p class="hint">Its first bubble is called after it.</p>
		</div>
		<button class="primary" disabled={creating}>Create repository</button>
	</form>
</Dialog>

<style>
	.page { padding: 2rem clamp(1rem, 3vw, 2.5rem); max-width: 72rem; }
	h1 { margin-bottom: 1.25rem; }
	.tools { margin-bottom: 1rem; max-width: 20rem; }
	table { width: 100%; border-collapse: collapse; background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
	th { text-align: left; font-size: 0.8125rem; font-weight: 500; color: var(--ink-3); padding: 0.6rem 1rem; border-bottom: 1px solid var(--line); }
	td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line-2); font-size: 0.9375rem; }
	tr:last-child td { border-bottom: 0; }
	tbody tr:hover { background: var(--raised); }
	.name { font-weight: 500; text-decoration: none; }
	.id { margin-left: 0.6rem; font-size: 0.75rem; }
	.name:hover { text-decoration: underline; }
	.forks { margin-left: 0.6rem; font-size: 0.8125rem; }
	.empty { max-width: 32rem; padding: 2rem; background: var(--paper); border: 1px dashed var(--line); border-radius: var(--r-md); }
	.empty p { margin: 0.5rem 0 1.25rem; color: var(--ink-2); }
	@media (max-width: 640px) {
		th:nth-child(3), td:nth-child(3) { display: none; }
		.forks { display: none; }
	}
</style>
