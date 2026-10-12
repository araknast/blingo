<script lang="ts">
	import Mark from "../lib/Mark.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import Shell from "../lib/Shell.svelte";
	import { navigate } from "../lib/router.svelte";
	import { api, loadMe, session } from "../lib/session.svelte";
	import { toastError } from "../lib/toast.svelte";
	import type { RepoSummary } from "../lib/types";
	import { repoName } from "../lib/util";

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
	const count = new Intl.NumberFormat();
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
			<label class="search">
				<span class="visually-hidden">Filter repositories</span>
				<input type="search" placeholder="Filter by name" bind:value={filter} />
				<kbd aria-hidden="true">/</kbd>
			</label>
			<table>
				<thead>
					<tr><th>Name</th><th class="num">Bubbles</th><th class="num wide">Forks</th><th class="num wide">Agents working</th><th class="num">Conflicts</th><th class="created">Created</th></tr>
				</thead>
				<tbody>
					{#each visible as r (r)}
						{@const s = summaries[r]}
						{@const made = session.me?.created?.[r]}
						{@const needs = s && s !== "error" ? s.needs : 0}
						<tr>
							<td>
								<a class="name" href="/repos/{r}">{nameOf(r)}</a>
								{#if needs}<span class="needs" title="{needs} {needs === 1 ? 'needs' : 'need'} you">{needs}<span class="visually-hidden"> {needs === 1 ? "needs" : "need"} you</span></span>{/if}
								{#if nameOf(r) !== r}<span class="muted id mono">{r}</span>{/if}
							</td>
							{#if s === "error"}
								<td colspan="4" class="num muted">Couldn't load <button class="link" onclick={() => delete summaries[r]}>Retry</button></td>
							{:else if !s}
								<td colspan="4" class="num muted">Loading…</td>
							{:else}
								<td class="num">{count.format(s.bubbles)}</td>
								<td class="num wide" class:muted={!s.forks}>{count.format(s.forks)}</td>
								<td class="num wide" class:muted={!s.working}>{#if s.working}<Mark status="running" />{/if} {count.format(s.working)}</td>
								<td class="num" class:muted={!s.conflicts}>{#if s.conflicts}<Mark status="conflict" />{/if} {count.format(s.conflicts)}</td>
							{/if}
							<td class="created">{#if made}<time datetime={new Date(made).toISOString()} title={new Date(made).toLocaleString()}>{dateFmt.format(made)}</time>{:else}<span class="muted">—</span>{/if}</td>
						</tr>
					{:else}
						<tr><td colspan="6" class="muted">No repository matches “{filter}”.</td></tr>
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
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 72rem; }
	h1 { margin-bottom: 1rem; }
	.search { margin-bottom: 1rem; }
	.search input { width: 18rem; max-width: 70vw; }
	table { width: 100%; border-collapse: separate; border-spacing: 0; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
	th { text-align: left; font-size: 0.8125rem; font-weight: 500; color: var(--ink-3); padding: 0.6rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); white-space: nowrap; }
	td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line-2); font-size: 0.9375rem; }
	tr:last-child td { border-bottom: 0; }
	/* Proportional figures: tabular ones give the grouping comma a full figure's width ("1 , 240"). */
	.num { text-align: right; white-space: nowrap; }
	/* The whole row opens the repository: the name's link covers it. */
	tbody tr { position: relative; }
	tbody tr:hover { background: var(--paper); }
	.name { font-weight: 500; text-decoration: none; }
	.name::after { content: ""; position: absolute; inset: 0; }
	.name:focus-visible { outline: 0; }
	tbody tr:has(.name:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
	tbody tr:hover .name { text-decoration: underline; text-underline-offset: 0.15em; }
	.id { margin-left: 0.5rem; font-size: 0.75rem; white-space: nowrap; }
	.created { white-space: nowrap; text-align: right; }
	td.created { color: var(--ink-2); }
	.link { position: relative; padding: 0; margin-left: 0.4rem; border: 0; background: none; color: var(--ink); font-size: inherit; text-decoration: underline; text-underline-offset: 0.15em; }
	.empty { max-width: 32rem; padding: 2rem; background: var(--paper); border: 1px dashed var(--line); border-radius: var(--r-md); }
	.empty p { margin: 0.5rem 0 1.25rem; color: var(--ink-2); }
	.needs { display: inline-block; margin-left: 0.5rem; min-width: 1.4rem; text-align: center; padding: 0 0.4rem; border-radius: 999px; background: var(--conflict); color: #fff; font-size: 0.75rem; font-weight: 600; line-height: 1.5; vertical-align: 0.1em; font-variant-numeric: tabular-nums; }
	@media (prefers-color-scheme: dark) { .needs { color: #0f1821; } }
	@media (max-width: 640px) {
		.wide, .created, .id { display: none; }
	}
</style>
