<script lang="ts" module>
	// Where a task's links go: full pages, or (in the map's drawer) the drawer's own views.
	export type TaskLinks = { task: (id: string) => string; run: (fork: string) => string; fork: (fork: string) => string };
</script>

<script lang="ts">
	// One task: what it asks, where it stands, and what can be done with it. Its own page, and the map's drawer.
	import { ask } from "../../lib/confirm.svelte";
	import Dialog from "../../lib/Dialog.svelte";
	import ForkCommands from "../../lib/ForkCommands.svelte";
	import Markdown from "../../lib/Markdown.svelte";
	import TaskIcon from "../../lib/TaskIcon.svelte";
	import { api } from "../../lib/session.svelte";
	import { toast, toastError } from "../../lib/toast.svelte";
	import type { RepoState, Task } from "../../lib/types";
	import { agentLabel, ago, duration, short } from "../../lib/util";

	let {
		task: t,
		data,
		repo,
		refresh,
		links = {
			task: (id) => `/repos/${repo}/tasks/${id}`,
			run: (fork) => `/repos/${repo}/agents/${fork}`,
			fork: (fork) => `/repos/${repo}/forks/${fork}`,
		},
		ongone,
	}: { task: Task; data: RepoState; repo: string; refresh: () => unknown; links?: TaskLinks; ongone?: () => void } = $props();

	const byId = $derived(new Map(data.tasks.map((x) => [x.id, x])));
	const deps = $derived(t.deps.map((d) => byId.get(d)).filter((x): x is Task => !!x));
	const waitingOn = $derived(deps.filter((d) => d.status !== "completed"));
	const blocks = $derived(data.tasks.filter((x) => x.deps.includes(t.id)));
	const run = $derived(t.fork ? data.agents.find((a) => a.fork === t.fork) : undefined);
	const plan = $derived(t.superagent ? data.agents.find((a) => a.fork === t.superagent) : undefined);
	const bubbleName = (id: string) => data.bubbles.find((b) => b.id === id)?.name || short(id);
	const forkHref = $derived(t.fork ? (run ? links.run(t.fork) : links.fork(t.fork)) : undefined);
	const statusText = $derived(
		t.status === "open"
			? t.ready
				? t.kind === "agent"
					? "Starting"
					: "Ready to take"
				: waitingOn.length
					? `Waiting for ${waitingOn.length === 1 ? "a task" : `${waitingOn.length} tasks`} it depends on`
					: "Waiting for its dependencies to land in one bubble"
			: { "awaiting-approval": "Awaiting approval", "in-progress": "In progress", completed: "Completed", failed: "Failed" }[t.status],
	);
	// Why it failed: the run's state, and the end of its sandbox log.
	const tail = $derived(run?.log?.trim().split("\n").slice(-4).join("\n"));

	async function act(path: string, done: string, body?: unknown) {
		try {
			const r = await api("POST", `/repos/${repo}/tasks/${t.id}/${path}`, body);
			if (path === "take") ((pushed = r as typeof pushed), (takeOpen = true));
			else toast(done);
			await refresh();
			return true;
		} catch (e) {
			toastError(e);
			return false;
		}
	}
	let pushed = $state<{ fork: string; clone: string; push: string } | null>(null);
	let takeOpen = $state(false);

	async function stop() {
		if (await ask({ title: "Stop this agent?", body: "Its work so far is discarded. Its transcript is kept, so a retry can pick up from it.", confirm: "Stop agent", danger: true }))
			act("stop", "Agent stopped");
	}
	async function reject() {
		if (!(await ask({ title: "Reject this task?", body: `"${t.title}" is deleted and never starts.`, confirm: "Reject task", danger: true }))) return;
		if (await act("reject", "Task rejected")) ongone?.();
	}

	// A task awaiting approval can be edited before it's approved.
	let editing = $state(false);
	let title = $state("");
	let description = $state("");
	function startEdit() {
		title = t.title;
		description = t.description;
		editing = true;
	}
	async function save(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api("PATCH", `/repos/${repo}/tasks/${t.id}`, { title, description });
			await refresh();
			editing = false;
		} catch (err) {
			toastError(err);
		}
	}
</script>

<div class="tv">
<header class="head">
	<h1 tabindex="-1">{t.title} <span class="id mono">#{t.id.slice(2)}</span></h1>
	<p class="sub">
		<span class="pill {t.status}"><TaskIcon status={t.status} /> {statusText}</span>
		{#if t.role === "ferge"}<span class="pill">Ferge</span>{/if}
		<span class="muted">opened {ago(t.created)}{#if t.finished}, {t.status === "completed" ? "completed" : "failed"} {ago(t.finished)}{/if}</span>
	</p>
</header>

{#if t.status === "failed"}
	<div class="callout failure">
		<div>
			<p><strong>{run ? `Its agent ${agentLabel(run.status).toLowerCase()}` : "It failed"}.</strong> Retry starts a new agent with what the last one learned.</p>
			{#if tail}<pre>{tail}</pre>{/if}
			{#if t.fork && forkHref}<p><a href={forkHref}>{run ? "Read its transcript" : "Open its fork"}</a></p>{/if}
		</div>
	</div>
{/if}

<div class="cols">
	<article>
		<section class="card">
			<h2 class="card-head">Description</h2>
			<Markdown text={t.description} />
		</section>

		{#if t.explanation}
			<section class="card">
				<h2 class="card-head">Work done</h2>
				<Markdown text={t.explanation} />
			</section>
		{/if}

		{#if run}
			<section class="card">
				<h2 class="card-head">
					Agent run <span class="muted">{agentLabel(run.status)}{run.finished ? `, took ${duration(run.finished - run.started)}` : `, started ${ago(run.started)}`}</span>
					<a class="head-link" href={links.run(run.fork)}>Transcript</a>
				</h2>
				{#if run.log}<details><summary>Sandbox log</summary><pre>{run.log}</pre></details>{:else}<p class="muted pad">No sandbox log was kept.</p>{/if}
			</section>
		{/if}
	</article>

	<aside>
		{#if t.status === "awaiting-approval"}
			{#if editing}
				<form class="edit" onsubmit={save}>
					<label for="edit-title">Title</label>
					<input id="edit-title" bind:value={title} required maxlength="60" />
					<label for="edit-description">Description</label>
					<textarea id="edit-description" bind:value={description} rows="8"></textarea>
					<div class="row"><button class="primary">Save</button><button type="button" onclick={() => (editing = false)}>Cancel</button></div>
				</form>
			{:else}
				<button class="primary wide" onclick={() => act("approve", "Task approved")}>Approve</button>
				<div class="row"><button class="grow" onclick={startEdit}>Edit</button><button class="grow danger" onclick={reject}>Reject</button></div>
			{/if}
		{:else if t.status === "open" && t.kind === "notagent" && t.ready}
			<button class="primary wide" onclick={() => act("take", "")}>Take this task</button>
		{:else if t.status === "failed"}
			<button class="primary wide" onclick={() => act("retry", "Task reopened. A new agent starts on it")}>Retry</button>
		{:else if t.status === "in-progress" && t.kind === "agent"}
			<button class="wide danger" onclick={stop}>Stop agent</button>
		{/if}

		<dl>
			<dt>Assignee</dt>
			<dd>{t.kind === "agent" ? "An agent" : "A notagent: someone takes it and pushes"}</dd>

			<dt>Depends on</dt>
			<dd>
				{#if deps.length}
					<ul>{#each deps as d (d.id)}<li><TaskIcon status={d.status} /><a href={links.task(d.id)}>{d.title}</a></li>{/each}</ul>
				{:else}<span class="muted">Nothing</span>{/if}
			</dd>

			<dt>Blocks</dt>
			<dd>
				{#if blocks.length}
					<ul>{#each blocks as d (d.id)}<li><TaskIcon status={d.status} /><a href={links.task(d.id)}>{d.title}</a></li>{/each}</ul>
				{:else}<span class="muted">Nothing</span>{/if}
			</dd>

			{#if t.bubble}
				<dt>{t.status === "open" ? "Starts from" : "Started from"}</dt>
				<dd><a href="/repos/{repo}/b/{t.bubble}">{bubbleName(t.bubble)}</a></dd>
			{/if}

			{#if t.fork}
				<dt>Fork</dt>
				<dd>{#if forkHref}<a class="mono" href={forkHref}>{short(t.fork)}</a>{:else}<span class="mono">{short(t.fork)}</span>{/if}</dd>
			{/if}

			{#if t.superagent}
				<dt>Planned by</dt>
				<dd>A superagent{#if plan}, asked: <q>{plan.prompt}</q>{/if}</dd>
			{/if}
		</dl>
	</aside>
</div>
</div>

<Dialog bind:open={takeOpen} title="Take this task" wide>
	{#if pushed}<ForkCommands {pushed} />{/if}
</Dialog>

<style>
	.head { margin-bottom: 1.25rem; }
	h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; text-wrap: balance; }
	.id { font-size: 1.125rem; font-weight: 400; color: var(--ink-3); }
	.sub { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-top: 0.5rem; font-size: 0.875rem; }
	.pill { display: inline-flex; gap: 0.4rem; align-items: center; padding: 0.2rem 0.7rem 0.2rem 0.45rem; border-radius: 999px; border: 1px solid var(--line); font-weight: 500; }
	.failure { margin-bottom: 1.25rem; }
	.failure p + p, .failure pre + p { margin-top: 0.4rem; }
	.failure pre { margin: 0.5rem 0 0; padding: 0.5rem 0.65rem; background: var(--raised); border: 1px solid var(--line-2); border-radius: var(--r-sm); font-size: 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 8rem; overflow: auto; }
	.cols { display: grid; grid-template-columns: minmax(0, 1fr) 17rem; gap: 1.5rem; align-items: start; }
	.tv { container-type: inline-size; }
	article { display: grid; gap: 1rem; min-width: 0; }
	.card { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	.card-head { font-size: 0.875rem; font-weight: 600; padding: 0.6rem 1rem; background: var(--paper); border-bottom: 1px solid var(--line); display: flex; gap: 0.5rem; align-items: baseline; }
	.card-head .muted { font-weight: 400; }
	.head-link { margin-left: auto; font-weight: 500; }
	.card :global(.md) { padding: 1rem 1.25rem; }
	details { padding: 0.6rem 1rem; font-size: 0.8125rem; }
	summary { cursor: pointer; color: var(--ink-2); }
	details pre { max-height: 24rem; overflow: auto; padding: 0.6rem; margin: 0.5rem 0 0; background: var(--fog); border-radius: var(--r-sm); white-space: pre-wrap; font-size: 0.75rem; }
	.pad { padding: 0.75rem 1rem; font-size: 0.875rem; }
	aside { display: grid; gap: 0.6rem; font-size: 0.875rem; align-content: start; }
	.wide { width: 100%; justify-content: center; }
	.row { display: flex; gap: 0.5rem; }
	.grow { flex: 1; justify-content: center; }
	button.danger { color: var(--conflict); }
	dl { margin: 0.6rem 0 0; display: grid; gap: 0.25rem; }
	dt { font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); margin-top: 0.75rem; }
	dt:first-child { margin-top: 0; }
	dd { margin: 0; overflow-wrap: anywhere; }
	dd ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
	dd li { display: flex; gap: 0.45rem; align-items: flex-start; }
	dd li :global(.icon) { margin-top: 0.2rem; }
	q { font-style: italic; }
	@container (max-width: 46rem) { .cols { grid-template-columns: 1fr; } }
	.edit { display: grid; gap: 0.4rem; margin-bottom: 1rem; }
</style>
