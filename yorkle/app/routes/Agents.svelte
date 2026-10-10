<script lang="ts">
	// The repository's runs (agents, CI fixers, superagents, and people's forks), newest first; one opens
	// its transcript, or for a person's fork its fork page.
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { session } from "../lib/session.svelte";
	import type { AgentRun } from "../lib/types";
	import { agentLabel, ago, allRuns, duration, repoName, runDot } from "../lib/util";
	import AgentView from "./agents/AgentView.svelte";

	let { repo, id }: { repo: string; id?: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 4000);
	const runs = $derived(rd.data ? allRuns(rd.data) : []);
	const run = $derived(id ? runs.find((r) => r.fork === id) : undefined);
	// The agent task this run is working on, if any: it can be stopped.
	const task = $derived(id ? rd.data?.tasks.find((t) => t.kind === "agent" && t.status === "in-progress" && t.fork === id)?.id : undefined);
	const kind = (fork: string) => (fork.includes("-s-") ? "Superagent" : /-c\d+$/.test(fork) ? "CI fixer" : "Agent");
	const kindOf = (r: AgentRun) => (r.kind === "notagent" ? "Person" : kind(r.fork));
	const href = (r: AgentRun) => (r.kind === "notagent" ? `/repos/${repo}/forks/${r.fork}` : `/repos/${repo}/agents/${r.fork}`);
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		...(id ? [{ label: "Agents", href: `/repos/${repo}/agents` }, { label: run?.prompt.split("\n")[0] ?? id.split(/-[fsc]-/).at(-1) ?? id }] : [{ label: "Agents" }]),
	]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
>
	<div class="page">
		{#if rd.missing}
			<h1>This repository isn't available</h1>
			<p class="muted">It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		{:else if id}
			<AgentView {repo} {id} {run} {task} kind={kind(id)} />
		{:else}
			<h1>Agents</h1>
			{#if !rd.data}
				<p class="muted">Loading…</p>
			{:else if !runs.length}
				<p class="muted">No agent has run here yet, and nobody has taken a task. Start one from the map or the Tasks tab.</p>
			{:else}
				<ul class="runs">
					{#each runs as r (r.fork)}
						<li>
							<a href={href(r)}>
								<span class="status"><i class="dot {runDot(r)}"></i>{agentLabel(r.status)}</span>
								<span class="prompt">{r.prompt.split("\n")[0]}</span>
								<span class="muted small">{kindOf(r)} · {r.finished ? `took ${duration(r.finished - r.started)}` : `started ${ago(r.started)}`}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 64rem; }
	h1 { margin-bottom: 1rem; }
	.runs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	.runs li + li { border-top: 1px solid var(--line-2); }
	.runs a { display: grid; grid-template-columns: 8.5rem 1fr auto; gap: 1rem; align-items: center; padding: 0.75rem 1rem; color: inherit; text-decoration: none; }
	.runs a:hover { background: var(--fog); }
	.status { display: inline-flex; align-items: center; gap: 0.45rem; font-size: 0.8125rem; font-weight: 500; }
	.prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.small { font-size: 0.8125rem; white-space: nowrap; }
	@media (max-width: 700px) {
		.runs a { grid-template-columns: 1fr; gap: 0.25rem; }
	}
</style>
