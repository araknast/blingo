<script lang="ts">
	import Markdown from "../../lib/Markdown.svelte";
	import TaskIcon from "../../lib/TaskIcon.svelte";
	import type { RepoState, Task } from "../../lib/types";
	import { agentLabel, ago, duration, short } from "../../lib/util";

	let {
		task: t,
		data,
		href,
		repo,
		ontake,
		onretry,
	}: { task: Task; data: RepoState; href: (id: string) => string; repo: string; ontake: (id: string) => void; onretry: (id: string) => void } =
		$props();

	const byId = $derived(new Map(data.tasks.map((x) => [x.id, x])));
	const deps = $derived(t.deps.map((d) => byId.get(d)).filter((x): x is Task => !!x));
	const blocks = $derived(data.tasks.filter((x) => x.deps.includes(t.id)));
	const run = $derived(t.fork ? data.agents.find((a) => a.fork === t.fork) : undefined);
	const plan = $derived(t.superagent ? data.agents.find((a) => a.fork === t.superagent) : undefined);
	const statusText = $derived(
		t.status === "open"
			? t.ready
				? t.kind === "agent"
					? "Starting"
					: "Ready to take"
				: "Waiting for its dependencies to land in one bubble"
			: { "in-progress": "In progress", completed: "Completed", failed: "Failed" }[t.status],
	);
</script>

<header class="head">
	<h1>{t.title} <span class="id mono">#{t.id.slice(2)}</span></h1>
	<p class="sub">
		<span class="pill {t.status}"><TaskIcon status={t.status} /> {statusText}</span>
		<span class="muted">opened {ago(t.created)}{#if t.finished}, {t.status === "completed" ? "completed" : "failed"} {ago(t.finished)}{/if}</span>
	</p>
</header>

<div class="cols">
	<article>
		<section class="card">
			<h2 class="card-head">Description</h2>
			<Markdown text={t.description} />
		</section>

		{#if t.explanation}
			<section class="card">
				<h2 class="card-head">Work done</h2>
				<pre class="work">{t.explanation}</pre>
			</section>
		{/if}

		{#if run}
			<section class="card">
				<h2 class="card-head">
					Agent run <span class="muted">{agentLabel(run.status)}{run.finished ? `, took ${duration(run.finished - run.started)}` : `, started ${ago(run.started)}`}</span>
				</h2>
				{#if run.log}<details><summary>Log</summary><pre>{run.log}</pre></details>{:else}<p class="muted pad">No log yet.</p>{/if}
			</section>
		{/if}
	</article>

	<aside>
		{#if t.status === "open" && t.kind === "notagent" && t.ready}
			<button class="primary wide" onclick={() => ontake(t.id)}>Take this task</button>
		{:else if t.status === "failed"}
			<button class="primary wide" onclick={() => onretry(t.id)}>Retry</button>
		{/if}

		<dl>
			<dt>Assignee</dt>
			<dd>{t.kind === "agent" ? "Agent" : "Human"}</dd>

			<dt>Depends on</dt>
			<dd>
				{#if deps.length}
					<ul>{#each deps as d (d.id)}<li><TaskIcon status={d.status} /><a href={href(d.id)}>{d.title}</a></li>{/each}</ul>
				{:else}<span class="muted">Nothing</span>{/if}
			</dd>

			<dt>Blocks</dt>
			<dd>
				{#if blocks.length}
					<ul>{#each blocks as d (d.id)}<li><TaskIcon status={d.status} /><a href={href(d.id)}>{d.title}</a></li>{/each}</ul>
				{:else}<span class="muted">Nothing</span>{/if}
			</dd>

			{#if t.bubble}
				<dt>{t.status === "open" ? "Starts from" : "Started from"}</dt>
				<dd>Bubble <a class="mono" href="/repos/{repo}/b/{t.bubble}">{short(t.bubble)}</a></dd>
			{/if}

			{#if t.fork}
				<dt>Fork</dt>
				<dd class="mono">{short(t.fork)}</dd>
			{/if}

			{#if t.superagent}
				<dt>Planned by</dt>
				<dd>A superagent{#if plan}, asked: <q>{plan.prompt}</q>{/if}</dd>
			{/if}
		</dl>
	</aside>
</div>

<style>
	.head { margin-bottom: 1.25rem; }
	h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
	.id { font-size: 1.125rem; font-weight: 400; color: var(--ink-3); }
	.sub { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 0.5rem; font-size: 0.875rem; }
	.pill { display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.2rem 0.7rem 0.2rem 0.35rem; border-radius: 999px; border: 1px solid var(--line); font-weight: 500; }
	.cols { display: grid; grid-template-columns: minmax(0, 1fr) 17rem; gap: 1.5rem; align-items: start; }
	article { display: grid; gap: 1rem; min-width: 0; }
	.card { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	.card-head { font-size: 0.875rem; font-weight: 600; padding: 0.6rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); display: flex; gap: 0.5rem; align-items: baseline; }
	.card-head .muted { font-weight: 400; }
	.card :global(.md) { padding: 1rem 1.25rem; }
	.work { margin: 0; padding: 1rem 1.25rem; white-space: pre-wrap; font-size: 0.8125rem; }
	details { padding: 0.6rem 1rem; font-size: 0.8125rem; }
	summary { cursor: pointer; color: var(--ink-2); }
	details pre { max-height: 24rem; overflow: auto; padding: 0.6rem; margin: 0.5rem 0 0; background: var(--fog); border-radius: var(--r-sm); white-space: pre-wrap; font-size: 0.75rem; }
	.pad { padding: 0.75rem 1rem; font-size: 0.875rem; }
	aside { display: grid; gap: 1rem; font-size: 0.875rem; }
	.wide { width: 100%; justify-content: center; }
	dl { margin: 0; display: grid; gap: 0.25rem; }
	dt { font-size: 0.75rem; font-weight: 600; color: var(--ink-3); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 0.75rem; }
	dt:first-child { margin-top: 0; }
	dd { margin: 0; overflow-wrap: anywhere; }
	dd ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
	dd li { display: flex; gap: 0.45rem; align-items: center; }
	q { font-style: italic; }
	@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
</style>
