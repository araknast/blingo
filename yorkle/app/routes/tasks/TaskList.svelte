<script lang="ts">
	// The task list, most urgent first: what needs you (failed, awaiting approval), what's ready to take,
	// then what's running, then what's waiting. Filters, a search (/), and j/k to move between tasks.
	import Pager, { PAGE } from "../../lib/Pager.svelte";
	import TaskIcon from "../../lib/TaskIcon.svelte";
	import { route } from "../../lib/router.svelte";
	import type { RepoState, Task } from "../../lib/types";
	import { ago, plural } from "../../lib/util";

	let {
		data,
		href,
		ontake,
		onretry,
		ondelete,
		onopen,
		onclose,
		onapprove,
		onreject,
		onnew,
		onplan,
	}: {
		data: RepoState;
		href: (id: string) => string;
		ontake: (id: string) => void;
		onretry: (id: string) => void;
		ondelete: (id: string) => void;
		// Opening a notagent a person closed (its task reads failed), and closing one that is still waiting
		// for its first push.
		onopen: (id: string) => void;
		onclose: (id: string) => void;
		onapprove: (ids: string[]) => void;
		onreject: (id: string) => void;
		onnew: () => void;
		onplan: () => void;
	} = $props();

	const isClosed = (t: Task) => !!t.fork && data.closed.includes(t.fork);
	const waitingForPush = (t: Task) => t.kind === "notagent" && t.status === "in-progress" && !!t.fork && data.waiting.includes(t.fork);

	const tab = $derived(new URLSearchParams(route.search).get("state") === "completed" ? "completed" : "open");
	const byId = $derived(new Map(data.tasks.map((t) => [t.id, t])));
	const openCount = $derived(data.tasks.filter((t) => t.status !== "completed").length);

	// "Needs you" is what the tab's badge counts (attention.ts `needs`): failed and awaiting approval.
	type Group = "needs" | "ready" | "running" | "waiting" | "done";
	const groupOf = (t: Task): Group =>
		t.status === "completed"
			? "done"
			: t.status === "failed" || t.status === "awaiting-approval"
				? "needs"
				: t.status === "open" && t.ready && t.kind === "notagent"
					? "ready"
					: t.status === "in-progress" || (t.status === "open" && t.ready)
						? "running"
						: "waiting";
	const GROUPS: { id: Group; label: string }[] = [
		{ id: "needs", label: "Needs you" },
		{ id: "ready", label: "Ready to take" },
		{ id: "running", label: "In progress" },
		{ id: "waiting", label: "Waiting" },
	];
	// Within a group: failures first, then approvals, then newest. A plan's tasks share a timestamp, and the
	// stable sort keeps them in plan order.
	const rank = (t: Task) => (t.status === "failed" ? 0 : t.status === "awaiting-approval" ? 1 : 2);

	let filter = $state<Group | "all">("all");
	let query = $state("");
	const counts = $derived(Object.fromEntries(GROUPS.map((g) => [g.id, data.tasks.filter((t) => groupOf(t) === g.id).length])) as Record<Group, number>);
	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase().replace(/^#/, "");
		return data.tasks
			.filter((t) => (tab === "completed" ? t.status === "completed" : t.status !== "completed"))
			.filter((t) => tab === "completed" || filter === "all" || groupOf(t) === filter)
			.filter((t) => !q || t.title.toLowerCase().includes(q) || t.id.slice(2).startsWith(q))
			.sort((a, b) =>
				tab === "completed"
					? (b.finished ?? 0) - (a.finished ?? 0)
					: GROUPS.findIndex((g) => g.id === groupOf(a)) - GROUPS.findIndex((g) => g.id === groupOf(b)) || rank(a) - rank(b) || b.created - a.created,
			);
	});
	let page = $state(0);
	$effect(() => {
		tab;
		filter;
		query;
		page = 0;
	});
	const visible = $derived(shown.slice(page * PAGE, (page + 1) * PAGE));
	const waitingOn = (t: Task) => t.deps.map((d) => byId.get(d)).filter((d): d is Task => !!d && d.status !== "completed");
	const planner = (t: Task) => (t.superagent ? data.agents.find((a) => a.fork === t.superagent)?.prompt : undefined);

	// Plans with tasks awaiting approval: one click approves the lot.
	const plans = $derived.by(() => {
		const by = new Map<string, Task[]>();
		for (const t of data.tasks) if (t.status === "awaiting-approval" && t.superagent) by.set(t.superagent, [...(by.get(t.superagent) ?? []), t]);
		return [...by].filter(([, ts]) => ts.length > 1).map(([s, ts]) => ({ id: s, prompt: data.agents.find((a) => a.fork === s)?.prompt ?? "A superagent's plan", tasks: ts }));
	});

</script>

<h1>Tasks</h1>
<div class="toolbar">
	<label class="search">
		<span class="visually-hidden">Find a task</span>
		<input type="search" bind:value={query} placeholder="Find a task by title or #id" />
		<kbd aria-hidden="true">/</kbd>
	</label>
	<span class="grow"></span>
	<button onclick={onplan}>Plan with a superagent</button>
	<button class="primary" onclick={onnew}>New task</button>
</div>

{#if tab === "open" && plans.length}
	<ul class="plans">
		{#each plans as p (p.id)}
			<li>
				<span><strong>{plural(p.tasks.length, "task")}</strong> from a superagent's plan await your approval to merge: <q>{p.prompt.split("\n")[0]}</q></span>
				<button class="primary" onclick={() => onapprove(p.tasks.map((t) => t.id))}>Approve all {p.tasks.length}</button>
			</li>
		{/each}
	</ul>
{/if}

<section class="box" aria-label="Tasks">
	<header class="box-head">
		<nav class="tabs" aria-label="Task state">
			<a href="?state=open" aria-current={tab === "open" ? "page" : undefined}>{openCount} Open</a>
			<a href="?state=completed" aria-current={tab === "completed" ? "page" : undefined}>{data.tasks.length - openCount} Completed</a>
		</nav>
		{#if tab === "open"}
			<div class="chips" role="group" aria-label="Show">
				<button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All</button>
				{#each GROUPS as g (g.id)}
					<button aria-pressed={filter === g.id} onclick={() => (filter = g.id)}>{g.label} <span class="n">{counts[g.id]}</span></button>
				{/each}
			</div>
		{/if}
	</header>
	{#if !shown.length}
		<div class="empty">
			{#if query}
				<h2>No task matches "{query}"</h2>
				<p class="muted">Search looks at titles and task numbers.</p>
			{:else if tab === "open" && filter !== "all"}
				<h2>Nothing here</h2>
				<p class="muted"><button class="link" onclick={() => (filter = "all")}>Show all open tasks</button></p>
			{:else if tab === "open"}
				<h2>No open tasks</h2>
				<p class="muted">Create one with <b>New task</b>, or describe a bigger change and let a superagent split it into tasks.</p>
			{:else}
				<h2>Nothing completed yet</h2>
				<p class="muted">A task completes when its fork lands in a bubble.</p>
			{/if}
		</div>
	{:else}
		<ul>
			{#each visible as t, i (t.id)}
				{@const g = groupOf(t)}
				{@const blockers = waitingOn(t)}
				{#if tab === "open" && filter === "all" && (i === 0 || groupOf(visible[i - 1]) !== g)}
					<li class="group-head" class:alert={g === "needs"}>{GROUPS.find((x) => x.id === g)?.label} <span class="n">{counts[g]}</span></li>
				{/if}
				<li class="task" class:failed={t.status === "failed"}>
					<TaskIcon status={t.status} />
					<div class="body">
						<div class="line">
							<a class="title" href={href(t.id)}>{t.title}</a>
							<span class="badge">{t.kind === "agent" ? "Agent" : "Notagent"}</span>
							{#if t.role === "ferge"}<span class="badge">Ferge</span>{/if}
							{#if isClosed(t)}<span class="badge failed">Closed</span>{:else if t.status === "failed"}<span class="badge failed">Failed</span>{/if}
							{#if t.status === "awaiting-approval"}<span class="badge">Awaiting approval</span>{/if}
							{#if t.status === "in-progress"}<span class="badge working">In progress</span>{/if}
							{#if t.status === "open" && t.ready && t.kind === "notagent"}<span class="badge">Ready to take</span>{/if}
						</div>
						<p class="meta">
							<span class="mono">#{t.id.slice(2)}</span>
							{#if t.status === "completed" && t.finished}· completed {ago(t.finished)}{:else}· opened {ago(t.created)}{/if}
							{#if t.status === "open" && !t.ready}
								· {#if blockers.length}waiting for <a href={href(blockers[0].id)}>{blockers[0].title}</a>{blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}{:else}waiting for its dependencies to land in one bubble{/if}
							{:else if t.deps.length}
								· depends on {plural(t.deps.length, "task")}
							{/if}
							{#if t.superagent}· planned by a superagent{#if planner(t)}: <span class="plan" title={planner(t)}>{planner(t)}</span>{/if}{/if}
						</p>
					</div>
					<div class="actions" class:fail={t.status === "failed"}>
						{#if t.status === "awaiting-approval"}
							<button onclick={() => onapprove([t.id])}>Approve</button>
							<button class="quiet danger" onclick={() => onreject(t.id)}>Reject</button>
						{:else if t.status === "open"}
							{#if t.kind === "notagent" && t.ready}<button onclick={() => ontake(t.id)}>Take</button>{/if}
							<button class="quiet danger" onclick={() => onreject(t.id)}>Reject</button>
						{:else if isClosed(t)}
							<button onclick={() => onopen(t.id)}>Open</button>
							<button class="quiet danger" onclick={() => ondelete(t.id)}>Delete</button>
						{:else if t.status === "failed"}
							<button onclick={() => onretry(t.id)}>Retry</button>
							<button class="quiet danger" onclick={() => ondelete(t.id)}>Delete</button>
						{:else if waitingForPush(t)}
							<button onclick={() => onclose(t.id)}>Close</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
		<Pager bind:page total={shown.length} />
	{/if}
</section>

<style>
	h1 { margin-bottom: 1rem; }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
	.toolbar .search input { width: 18rem; max-width: 70vw; }
	.grow { flex: 1; }
	.plans { list-style: none; margin: 0 0 1rem; padding: 0; display: grid; gap: 0.5rem; }
	.plans li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.7rem 1rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); font-size: 0.9375rem; }
	.plans q { color: var(--ink-2); }
	.box { border: 1px solid var(--line); border-radius: var(--r-md, 8px); background: var(--raised); overflow: hidden; }
	.box-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; padding: 0.6rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); font-size: 0.875rem; }
	.tabs { display: flex; gap: 1.25rem; }
	.tabs a { color: var(--ink-2); text-decoration: none; }
	.tabs a:hover { color: var(--ink); }
	.tabs a[aria-current="page"] { color: var(--ink); font-weight: 600; }
	ul { list-style: none; margin: 0; padding: 0; }
	.group-head { padding: 0.45rem 1rem; font-size: 0.75rem; font-weight: 600; color: var(--ink-2); background: var(--paper); border-top: 1px solid var(--line-2); }
	.group-head:first-child { border-top: 0; }
	.group-head.alert { color: var(--conflict); }
	.group-head .n { font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
	.task { display: flex; gap: 0.75rem; align-items: flex-start; padding: 0.75rem 1rem; border-top: 1px solid var(--line-2); }
	.task:hover, .task:focus-within { background: var(--paper); }
	.task > :global(.icon) { margin-top: 0.25rem; }
	.body { flex: 1; min-width: 0; }
	.line { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.title { font-weight: 600; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
	.title:hover { text-decoration: underline; }
	.title:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 2px; }
	.badge.failed { color: var(--conflict); border-color: currentColor; }
	.badge.working { color: var(--working); border-color: currentColor; }
	.meta { font-size: 0.8125rem; color: var(--ink-3); margin-top: 0.2rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.meta .mono { font-size: 0.75rem; }
	.meta a { color: var(--ink-2); }
	.plan { font-style: italic; }
	.actions { display: flex; align-items: center; gap: 0.4rem; flex: none; }
	.actions.fail { flex-direction: column; align-items: stretch; }
	.danger { color: var(--conflict); }
	.empty { padding: 3rem 1rem; text-align: center; }
	.empty h2 { font-size: 1.0625rem; margin-bottom: 0.4rem; }
	.empty p { max-width: 32rem; margin: 0 auto; }
	.link { background: none; border: 0; padding: 0; color: var(--focus); text-decoration: underline; }
	@media (max-width: 600px) {
		.task { flex-wrap: wrap; }
		.actions { width: 100%; justify-content: flex-end; }
	}
</style>
