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

	// Runs that need a person: the forks the tab's badge counts. A failed run's task needs you on the Tasks tab.
	const needy = $derived(new Set(rd.data ? needs(rd.data).flatMap((n) => (n.kind === "fork" ? [n.fork] : [])) : []));
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

</script>

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
			<AgentView {repo} {id} {run} {task} kind={runKind(run ?? { fork: id })} data={rd.data} />
		{:else}
			<h1>Agents</h1>
			{#if !rd.data}
				<p class="muted">Loading…</p>
			{:else}
				<div class="toolbar">
					<label class="search">
						<span class="visually-hidden">Find a run</span>
						<input type="search" bind:value={query} placeholder="Find by prompt or id" />
						<kbd aria-hidden="true">/</kbd>
					</label>
				</div>
				<section class="box" aria-label="Runs">
					<header class="box-head">
						<div class="chips" role="group" aria-label="Show">
							<button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All</button>
							{#each GROUPS as g (g.id)}
								<button aria-pressed={filter === g.id} onclick={() => (filter = g.id)}>{g.label} <span class="n">{counts[g.id]}</span></button>
							{/each}
						</div>
					</header>
					{#if !runs.length}
						<div class="empty">
							<h2>No runs yet</h2>
							<p class="muted">No agent has run here, and nobody has taken a task. Start one from the map or the Tasks tab.</p>
						</div>
					{:else if !listed.length}
						<div class="empty">
							{#if query}<h2>No run matches "{query}"</h2><p class="muted">Search looks at prompts and run ids.</p>
							{:else}<h2>Nothing here</h2><p class="muted"><button class="link" onclick={() => (filter = "all")}>Show every run</button></p>{/if}
						</div>
					{:else}
						<ul class="runs">
							{#each shown as r, i (r.fork)}
								{@const g = groupOf(r)}
								{#if filter === "all" && (i === 0 || groupOf(shown[i - 1]) !== g)}
									<li class="group-head" class:alert={g === "needs"}>{GROUPS.find((x) => x.id === g)?.label} <span class="n">{counts[g]}</span></li>
								{/if}
								<li class="run" class:needs={g === "needs"}>
									<Mark status={runMark(r, rd.data)} />
									<div class="body">
										<a class="title" href={href(r)} title={r.prompt}>{r.prompt.split("\n")[0] || `${runKind(r)} run`}</a>
										<span class="badge">{runKind(r)}</span>
										<p class="meta"><span class="mono">#{runId(r.fork)}</span> · <span class="state">{runLabel(r, rd.data)}</span> · {r.finished ? `took ${duration(r.finished - r.started)}` : `started ${ago(r.started)}`}</p>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
				<Pager bind:page total={listed.length} />
			{/if}
		{/if}
	</div>
</Shell>

<style>
	/* The list is laid out like the Tasks list (TaskList): a box with the filters in its head. */
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 80rem; }
	h1 { font-weight: 600; margin-bottom: 1rem; }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
	.toolbar .search input { width: 18rem; max-width: 70vw; }
	.box { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	.box-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; padding: 0.6rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); font-size: 0.875rem; }
	.runs { list-style: none; margin: 0; padding: 0; }
	.group-head { padding: 0.45rem 1rem; font-size: 0.75rem; font-weight: 600; color: var(--ink-2); background: var(--paper); border-top: 1px solid var(--line-2); }
	.group-head:first-child { border-top: 0; }
	.group-head.alert { color: var(--conflict); }
	.group-head .n { font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
	.run { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem 1rem; border-top: 1px solid var(--line-2); }
	.group-head + .run, .runs > .run:first-child { border-top: 0; }
	.run > :global(svg) { flex: none; margin-top: 0.2rem; }
	.body { min-width: 0; flex: 1; }
	.title { font-weight: 600; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; margin-right: 0.4rem; }
	.title:hover { text-decoration: underline; }
	.title:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
	.meta { font-size: 0.8125rem; color: var(--ink-3); margin-top: 0.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.meta .mono { font-size: 0.75rem; }
	.needs .state { color: var(--conflict); font-weight: 500; }
	.empty { padding: 3rem 1rem; text-align: center; }
	.empty h2 { font-size: 1.0625rem; margin-bottom: 0.4rem; }
	.empty p { max-width: 32rem; margin: 0 auto; }
	.link { background: none; border: 0; padding: 0; color: var(--focus); text-decoration: underline; }
</style>
