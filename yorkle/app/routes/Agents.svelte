<script lang="ts">
	// The repository's runs (agents, CI fixers, superagents, and notagents' forks), most urgent first: what
	// needs you, then what's working, then the rest, newest first. One opens its transcript, or for a fork
	// that waits on a person, its fork page.
	import { needs } from "../lib/attention";
	import Mark from "../lib/Mark.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { session } from "../lib/session.svelte";
	import type { AgentRun } from "../lib/types";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import { active, ago, allRuns, duration, repoName, runId, runKind, runLabel, runMark } from "../lib/util";
	import AgentView from "./agents/AgentView.svelte";

	let { repo, id }: { repo: string; id?: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 4000);
	const runs = $derived(rd.data ? allRuns(rd.data) : []);
	const run = $derived(id ? runs.find((r) => r.fork === id) : undefined);
	// The agent task this run is working on, if any: it can be stopped.
	const task = $derived(id ? rd.data?.tasks.find((t) => t.kind === "agent" && t.status === "in-progress" && t.fork === id)?.id : undefined);

	// Runs that need a person: forks the map lists, and failed runs whose task is still failed.
	const needy = $derived.by(() => {
		if (!rd.data) return new Set<string>();
		const forks = needs(rd.data).flatMap((n) => (n.kind === "fork" ? [n.fork] : []));
		const failed = rd.data.tasks.filter((t) => t.status === "failed" && t.fork).map((t) => t.fork!);
		return new Set([...forks, ...failed]);
	});
	type Group = "needs" | "working" | "done";
	const groupOf = (r: AgentRun): Group => (needy.has(r.fork) ? "needs" : active(r) || r.status === "loose" ? "working" : "done");
	const GROUPS: { id: Group; label: string }[] = [
		{ id: "needs", label: "Needs you" },
		{ id: "working", label: "Working" },
		{ id: "done", label: "Finished" },
	];
	let filter = $state<Group | "all">("all");
	let query = $state("");
	const counts = $derived(Object.fromEntries(GROUPS.map((g) => [g.id, runs.filter((r) => groupOf(r) === g.id).length])) as Record<Group, number>);
	const listed = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return runs
			.filter((r) => filter === "all" || groupOf(r) === filter)
			.filter((r) => !q || r.prompt.toLowerCase().includes(q) || runId(r.fork).startsWith(q))
			.sort((a, b) => GROUPS.findIndex((g) => g.id === groupOf(a)) - GROUPS.findIndex((g) => g.id === groupOf(b)));
	});
	let page = $state(0);
	$effect(() => {
		filter;
		query;
		page = 0;
	});
	const shown = $derived(listed.slice(page * PAGE, (page + 1) * PAGE));
	const reviewing = (r: AgentRun) => r.status === "loose" && !!rd.data?.loose.find((l) => l.fork === r.fork && l.reviewManual === "pending");
	const href = (r: AgentRun) => (r.kind === "notagent" || reviewing(r) ? `/repos/${repo}/forks/${r.fork}` : `/repos/${repo}/agents/${r.fork}`);

	let list = $state<HTMLElement>();
	let search = $state<HTMLInputElement>();
	function keys(e: KeyboardEvent) {
		if (id || e.ctrlKey || e.metaKey || e.altKey) return;
		const t = e.target as HTMLElement;
		if (t.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
		if (e.key === "/") (e.preventDefault(), search?.focus());
		else if (e.key === "j" || e.key === "k") {
			const links = [...(list?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
			if (!links.length) return;
			const i = links.indexOf(document.activeElement as HTMLAnchorElement);
			links[Math.max(0, Math.min(links.length - 1, i < 0 ? 0 : i + (e.key === "j" ? 1 : -1)))].focus();
			e.preventDefault();
		}
	}
</script>

<svelte:window onkeydown={keys} />

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		...(id ? [{ label: "Agents", href: `/repos/${repo}/agents` }, { label: run?.prompt.split("\n")[0] ?? runId(id) }] : [{ label: "Agents" }]),
	]}
	{repo}
	data={rd.data}
>
	<div class="page">
		{#if rd.missing}
			<h1>This repository isn't available</h1>
			<p class="muted">It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		{:else if id}
			<AgentView {repo} {id} {run} {task} kind={runKind({ fork: id })} data={rd.data} />
		{:else}
			<h1>Agents</h1>
			{#if !rd.data}
				<p class="muted">Loading…</p>
			{:else if !runs.length}
				<p class="muted">No agent has run here yet, and nobody has taken a task. Start one from the map or the Tasks tab.</p>
			{:else}
				<div class="toolbar">
					<label class="search">
						<span class="visually-hidden">Find a run</span>
						<input type="search" bind:this={search} bind:value={query} placeholder="Find by prompt or id" />
						<kbd aria-hidden="true">/</kbd>
					</label>
					<div class="chips" role="group" aria-label="Show">
						<button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="n">{runs.length}</span></button>
						{#each GROUPS as g (g.id)}
							<button aria-pressed={filter === g.id} onclick={() => (filter = g.id)}>{g.label} <span class="n">{counts[g.id]}</span></button>
						{/each}
					</div>
				</div>
				{#if !listed.length}
					<p class="muted">Nothing matches. <button class="link" onclick={() => ((filter = "all"), (query = ""))}>Show every run</button></p>
				{:else}
					<ul class="runs" bind:this={list}>
						{#each shown as r, i (r.fork)}
							{@const g = groupOf(r)}
							{#if filter === "all" && (i === 0 || groupOf(shown[i - 1]) !== g)}
								<li class="group-head" class:alert={g === "needs"}>{GROUPS.find((x) => x.id === g)?.label} <span class="n">{counts[g]}</span></li>
							{/if}
							<li>
								<a href={href(r)} class:needs={g === "needs"}>
									<span class="status"><Mark status={runMark(r, rd.data)} />{runLabel(r, rd.data)}</span>
									<span class="prompt" title={r.prompt}>{r.prompt.split("\n")[0]}</span>
									<span class="meta">{runKind(r)} <span class="mono">{runId(r.fork)}</span> · {r.finished ? `took ${duration(r.finished - r.started)}` : `started ${ago(r.started)}`}</span>
								</a>
							</li>
						{/each}
					</ul>
					<Pager bind:page total={listed.length} />
					<p class="keys muted"><kbd>/</kbd> find · <kbd>j</kbd> <kbd>k</kbd> move between runs · <kbd>Enter</kbd> opens one</p>
				{/if}
			{/if}
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 64rem; }
	h1 { margin-bottom: 1rem; }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem 1rem; margin-bottom: 1rem; }
	.toolbar .search input { width: 16rem; max-width: 70vw; }
	.runs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	.runs li + li { border-top: 1px solid var(--line-2); }
	.group-head { padding: 0.45rem 1rem; font-size: 0.75rem; font-weight: 600; color: var(--ink-2); background: var(--paper); }
	.group-head.alert { color: var(--conflict); }
	.group-head .n { font-weight: 500; color: var(--ink-3); }
	.runs a { display: grid; grid-template-columns: 11rem 1fr auto; gap: 1rem; align-items: center; padding: 0.75rem 1rem; color: inherit; text-decoration: none; }
	.runs a:hover, .runs a:focus-visible { background: var(--paper); }
	.runs a:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.status { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.8125rem; font-weight: 500; }
	.needs .status { color: var(--conflict); }
	.prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.meta { font-size: 0.8125rem; color: var(--ink-3); white-space: nowrap; }
	.link { background: none; border: 0; padding: 0; color: var(--focus); text-decoration: underline; }
	.keys { margin-top: 0.75rem; font-size: 0.8125rem; }
	.keys kbd { font-size: 0.75rem; padding: 0 0.3rem; border: 1px solid var(--line); border-radius: 3px; }
	@media (max-width: 700px) {
		.runs a { grid-template-columns: 1fr; gap: 0.25rem; }
		.keys { display: none; }
	}
</style>
