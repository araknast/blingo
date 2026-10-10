<script lang="ts">
	import TaskIcon from "../../lib/TaskIcon.svelte";
	import { route } from "../../lib/router.svelte";
	import type { RepoState, Task } from "../../lib/types";
	import { ago, plural } from "../../lib/util";

	let {
		data,
		href,
		ontake,
		onretry,
		onnew,
		onplan,
	}: {
		data: RepoState;
		href: (id: string) => string;
		ontake: (id: string) => void;
		onretry: (id: string) => void;
		onnew: () => void;
		onplan: () => void;
	} = $props();

	// Open = everything not completed (waiting, in progress, failed), like an issue tracker's open/closed.
	const state = $derived(new URLSearchParams(route.search).get("state") === "completed" ? "completed" : "open");
	const byId = $derived(new Map(data.tasks.map((t) => [t.id, t])));
	const openCount = $derived(data.tasks.filter((t) => t.status !== "completed").length);
	// Newest first; a plan's tasks share a timestamp, and the stable sort keeps them in plan order.
	const shown = $derived(
		data.tasks.filter((t) => (state === "completed") === (t.status === "completed")).sort((a, b) => b.created - a.created),
	);
	const blockedBy = (t: Task) => t.deps.filter((d) => byId.get(d)?.status !== "completed").length;
	const planner = (t: Task) => (t.superagent ? data.agents.find((a) => a.fork === t.superagent)?.prompt : undefined);
</script>

<div class="toolbar">
	<button onclick={onplan}>Plan with a superagent</button>
	<button class="primary" onclick={onnew}>New task</button>
</div>

<section class="box" aria-label="Tasks">
	<header class="box-head">
		<a href="?state=open" aria-current={state === "open" ? "page" : undefined}><span class="ring"></span>{openCount} Open</a>
		<a href="?state=completed" aria-current={state === "completed" ? "page" : undefined}>✓ {data.tasks.length - openCount} Completed</a>
	</header>
	{#if !shown.length}
		<div class="empty">
			{#if state === "open"}
				<h2>No open tasks</h2>
				<p class="muted">Create one with <b>New task</b>, or describe a bigger change and let a superagent split it into tasks.</p>
			{:else}
				<h2>Nothing completed yet</h2>
				<p class="muted">A task completes when its fork lands in a bubble.</p>
			{/if}
		</div>
	{:else}
		<ul>
			{#each shown as t (t.id)}
				{@const blocked = blockedBy(t)}
				<li>
					<TaskIcon status={t.status} />
					<div class="body">
						<div class="line">
							<a class="title" href={href(t.id)}>{t.title}</a>
							<span class="badge">{t.kind === "agent" ? "Agent" : "Human"}</span>
							{#if t.status === "failed"}<span class="badge failed">Failed</span>{/if}
							{#if t.status === "awaiting-approval"}<span class="badge">Needs approval</span>{/if}
							{#if t.status === "in-progress"}<span class="badge working">In progress</span>{/if}
							{#if t.status === "open" && !t.ready}
								<span class="badge">{blocked ? `Waiting on ${plural(blocked, "task")}` : "Waiting for a merge"}</span>
							{/if}
						</div>
						<p class="meta">
							<span class="mono">#{t.id.slice(2)}</span>
							{#if t.status === "completed" && t.finished}· completed {ago(t.finished)}{:else}· opened {ago(t.created)}{/if}
							{#if t.superagent}· planned by a superagent{#if planner(t)}: <span class="plan">{planner(t)}</span>{/if}{/if}
						</p>
					</div>
					<div class="actions">
						{#if t.status === "open" && t.kind === "notagent" && t.ready}
							<button onclick={() => ontake(t.id)}>Take</button>
						{:else if t.status === "failed"}
							<button onclick={() => onretry(t.id)}>Retry</button>
						{/if}
						{#if t.deps.length}<span class="muted deps" title="Depends on {plural(t.deps.length, 'task')}">↳ {t.deps.length}</span>{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.toolbar { display: flex; justify-content: flex-end; gap: 0.5rem; margin-bottom: 1rem; }
	.box { border: 1px solid var(--line); border-radius: var(--r-md, 8px); background: var(--raised); overflow: hidden; }
	.box-head { display: flex; gap: 1.25rem; padding: 0.75rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); font-size: 0.875rem; }
	.box-head a { color: var(--ink-3); text-decoration: none; display: inline-flex; align-items: center; gap: 0.4rem; }
	.box-head a:hover { color: var(--ink); }
	.box-head a[aria-current="page"] { color: var(--ink); font-weight: 600; }
	.ring { width: 0.75rem; height: 0.75rem; border-radius: 50%; box-shadow: inset 0 0 0 2px currentColor; }
	ul { list-style: none; margin: 0; padding: 0; }
	li { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem 1rem; border-top: 1px solid var(--line-2); }
	li:first-child { border-top: 0; }
	li:hover { background: var(--paper); }
	li > :global(.icon) { margin-top: 0.2rem; }
	.body { flex: 1; min-width: 0; }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.title { font-weight: 600; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
	.title:hover { text-decoration: underline; }
	.badge.failed { color: var(--conflict); border-color: currentColor; }
	.badge.working { color: var(--working); border-color: currentColor; }
	.meta { font-size: 0.8125rem; color: var(--ink-3); margin-top: 0.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.meta .mono { font-size: 0.75rem; }
	.plan { font-style: italic; }
	.actions { display: flex; align-items: center; gap: 0.75rem; flex: none; }
	.deps { font-size: 0.8125rem; }
	.empty { padding: 3rem 1rem; text-align: center; }
	.empty h2 { font-size: 1.0625rem; margin-bottom: 0.4rem; }
	.empty p { max-width: 32rem; margin: 0 auto; }
	@media (max-width: 600px) {
		li { flex-wrap: wrap; }
		.actions { width: 100%; justify-content: flex-end; }
	}
</style>
