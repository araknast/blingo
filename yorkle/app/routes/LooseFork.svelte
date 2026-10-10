<script lang="ts">
	// A fork that isn't in a bubble yet (a person's waits here for its pushes): its task, CI and reviews,
	// and what can be done next. A person's fork is listed with the agents and opens here.
	import Dialog from "../lib/Dialog.svelte";
	import ForkCommands from "../lib/ForkCommands.svelte";
	import Markdown from "../lib/Markdown.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import { repoName, short } from "../lib/util";

	let { repo, fork }: { repo: string; fork: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 3000);
	const l = $derived(rd.data?.loose.find((x) => x.fork === fork));
	const placing = $derived(rd.data?.placing.includes(fork));
	const waiting = $derived(rd.data?.waiting.includes(fork));
	const placedIn = $derived(rd.data?.bubbles.find((b) => b.members.some((m) => m.name === fork)));
	const task = $derived(rd.data?.tasks.find((t) => t.fork === fork));
	const ci = $derived(rd.data?.settings.ci.enabled);

	let pushed = $state<{ fork: string; clone: string; push: string } | null>(null);
	let pushOpen = $state(false);
	async function act(path: string, body?: unknown, done?: string) {
		try {
			const r = await api("POST", `/repos/${repo}/forks/${fork}/${path}`, body);
			if (path === "token") ((pushed = r), (pushOpen = true));
			if (done) toast(done);
			await rd.refresh();
		} catch (e) {
			toastError(e);
		}
	}
	const label = { running: "Running", passed: "Passed", failed: "Failed", pending: "Waiting", approved: "Approved", rejected: "Rejected" } as Record<string, string>;
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		{ label: "Agents", href: `/repos/${repo}/agents` },
		{ label: task?.title ?? `Fork ${short(fork)}` },
	]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
>
	<div class="page">
		<p class="muted kind">{l?.kind === "agent" ? "An agent's fork" : "A person's fork"}</p>
		<h1>{task?.title ?? `Fork ${short(fork)}`}</h1>
		{#if task?.description && task.description !== task.title}<details class="task"><summary>Task</summary><Markdown text={task.description} /></details>{/if}
		{#if !rd.data}
			<p class="muted">Loading…</p>
		{:else if placedIn}
			<p>It's placed: it joined <a href="/repos/{repo}/b/{placedIn.id}">{placedIn.name || short(placedIn.id)}</a>.</p>
		{:else if placing}
			<p><i class="dot placing pulse"></i> Being placed in a bubble…</p>
		{:else if waiting}
			<p><i class="dot waiting"></i> Waiting for its first push.</p>
			<div class="actions"><button class="primary" onclick={() => act("token")}>Push to it</button></div>
		{:else if !l}
			<p class="muted">This fork isn't waiting to be placed. <a href="/repos/{repo}">Back to the map</a></p>
		{:else}
			{#if l.reason}<p class="reason">{l.reason}</p>{/if}
			<dl>
				<dt>Pushes</dt>
				<dd>{l.pushes}</dd>
				{#if ci}
					<dt>CI</dt>
					<dd><i class="dot {l.ci === 'passed' ? 'merged' : l.ci === 'failed' ? 'conflict' : 'working pulse'}"></i> {label[l.ci ?? ""] ?? "Not run"}</dd>
					{#if l.reviewAuto}<dt>Automatic review</dt><dd>{label[l.reviewAuto]}</dd>{/if}
					{#if l.reviewManual}<dt>Review</dt><dd>{label[l.reviewManual]}</dd>{/if}
				{/if}
			</dl>
			<div class="actions">
				{#if l.reviewManual === "pending"}
					<button class="primary" onclick={() => act("review", { approve: true }, "Approved")}>Approve</button>
					<button onclick={() => act("review", { approve: false }, "Rejected")}>Reject</button>
				{/if}
				{#if !ci || (l.ci === "passed" && l.reviewAuto !== "pending" && l.reviewAuto !== "rejected" && l.reviewManual !== "pending" && l.reviewManual !== "rejected")}
					<button class="primary" onclick={() => act("place", undefined, "Placing it")}>Place it</button>
				{/if}
				{#if l.kind === "notagent"}<button onclick={() => act("token")}>Push to it</button>{/if}
			</div>
			{#if l.reviewNote}
				<h2>Review</h2>
				<pre>{l.reviewNote}</pre>
			{/if}
			{#if l.ciLog}
				<h2>CI output</h2>
				<pre>{l.ciLog}</pre>
			{/if}
		{/if}
	</div>
</Shell>

<Dialog bind:open={pushOpen} title="Push to this fork" wide>
	{#if pushed}<ForkCommands {pushed} />{/if}
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 56rem; }
	.kind { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.04em; }
	h1 { margin: 0.2rem 0 1rem; }
	h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
	.task { margin-bottom: 1.25rem; border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--raised); }
	.task summary { cursor: pointer; padding: 0.45rem 0.75rem; font-size: 0.875rem; color: var(--ink-2); }
	.task :global(.md) { padding: 0.25rem 1rem 0.5rem; }
	.reason { padding: 0.6rem 0.9rem; border-left: 3px solid var(--conflict); background: var(--raised); margin-bottom: 1rem; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0 0 1.25rem; }
	dt { color: var(--ink-3); }
	dd { margin: 0; display: flex; align-items: center; gap: 0.4rem; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	pre { max-height: 28rem; overflow: auto; padding: 0.75rem; background: var(--fog); border-radius: var(--r-sm); white-space: pre-wrap; font-size: 0.75rem; }
</style>
