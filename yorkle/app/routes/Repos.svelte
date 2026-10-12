<script lang="ts">
	import Mark from "../lib/Mark.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import Shell from "../lib/Shell.svelte";
	import { navigate } from "../lib/router.svelte";
	import { api, loadMe, session } from "../lib/session.svelte";
	import { toastError } from "../lib/toast.svelte";
	import type { RepoSummary } from "../lib/types";
	import { plural, repoName } from "../lib/util";

	let creating = $state(false);
	let filter = $state("");
	let summaries = $state<Record<string, RepoSummary | "error">>({});

	// A small count-only summary per repository, four at a time, retried: the busy ones are slow or briefly 503.
	const queue: string[] = [];
	let running = 0;
	async function load(r: string) {
		for (let i = 0; i < 4; i++) {
			try {
				summaries[r] = await api<RepoSummary>("GET", `/repos/${r}/summary`);
				return;
			} catch {
				await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
			}
		}
		summaries[r] = "error";
	}
	function pump() {
		while (running < 4 && queue.length) {
			running++;
			load(queue.shift()!).finally(() => {
				running--;
				pump();
			});
		}
	}
	$effect(() => {
		for (const r of session.me?.repos ?? []) {
			if (r in summaries || queue.includes(r)) continue;
			queue.push(r);
		}
		pump();
	});

	const nameOf = (r: string) => repoName(r, session.me?.names);
	const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
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

<Shell crumbs={[]} sidebar={false}>
	{#snippet actions()}
		<a class="button quiet" href="/settings" title="Settings every new repository starts with">Defaults</a>
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
				<button class="primary" onclick={() => (createOpen = true)} disabled={creating}>Create repository</button>
			</div>
			<table>
				<thead>
					<tr><th>Name</th><th>Bubbles</th><th>Agents working</th><th>Conflicts</th><th>Created</th></tr>
				</thead>
				<tbody>
					{#each visible as r (r)}
						{@const s = summaries[r]}
						{@const made = session.me?.created?.[r]}
						<tr>
							<td><a class="name" href="/repos/{r}">{nameOf(r)}</a>{#if s && s !== "error" && s.needs}<a class="needs" href="/repos/{r}" title="{s.needs} {s.needs === 1 ? 'needs' : 'need'} you" aria-label="{s.needs} {s.needs === 1 ? 'needs' : 'need'} you">{s.needs}</a>{/if}{#if nameOf(r) !== r}<span class="muted id mono">{r}</span>{/if}</td>
							{#if s === "error"}
								<td colspan="3" class="muted">Couldn't load</td>
							{:else if !s}
								<td colspan="3" class="muted">Loading</td>
							{:else}
								<td>{s.bubbles}<span class="muted forks">{plural(s.forks, "fork")}</span></td>
								<td>{#if s.working}<Mark status="running" /> {s.working}{:else}<span class="muted">None</span>{/if}</td>
								<td>{#if s.conflicts}<Mark status="conflict" /> {s.conflicts}{:else}<span class="muted">None</span>{/if}</td>
							{/if}
							<td class="created">{#if made}<time datetime={new Date(made).toISOString()} title={new Date(made).toLocaleString()}>{dateFmt.format(made)}</time>{:else}<span class="muted">—</span>{/if}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="muted">No repository matches “{filter}”.</td></tr>
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
	.page { padding: 2rem clamp(1rem, 3vw, 2.5rem); max-width: 72rem; margin: 0 auto; }
	h1 { margin-bottom: 1.25rem; }
	.tools { display: flex; gap: 0.75rem; justify-content: space-between; margin-bottom: 1rem; }
	.tools input { max-width: 20rem; }
	table { width: 100%; border-collapse: collapse; background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
	th { text-align: left; font-size: 0.8125rem; font-weight: 500; color: var(--ink-3); padding: 0.6rem 1rem; border-bottom: 1px solid var(--line); }
	td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line-2); font-size: 0.9375rem; }
	tr:last-child td { border-bottom: 0; }
	tbody tr:hover { background: var(--raised); }
	.name { font-weight: 500; text-decoration: none; }
	.id { margin-left: 0.6rem; font-size: 0.75rem; }
	.name:hover { text-decoration: underline; }
	.forks { margin-left: 0.6rem; font-size: 0.8125rem; }
	.created { white-space: nowrap; color: var(--ink-2); font-variant-numeric: tabular-nums; }
	.empty { max-width: 32rem; padding: 2rem; background: var(--paper); border: 1px dashed var(--line); border-radius: var(--r-md); }
	.empty p { margin: 0.5rem 0 1.25rem; color: var(--ink-2); }
	@media (max-width: 640px) {
		th:nth-child(3), td:nth-child(3), th:nth-child(5), td.created { display: none; }
		.forks { display: none; }
	}
	.needs { display: inline-block; margin-left: 0.6rem; min-width: 1.4rem; text-align: center; padding: 0 0.4rem; border-radius: 999px; background: var(--conflict); color: #fff; font-size: 0.75rem; font-weight: 600; line-height: 1.5; text-decoration: none; vertical-align: 0.1em; font-variant-numeric: tabular-nums; }
	.needs:hover { filter: brightness(1.08); }
</style>
