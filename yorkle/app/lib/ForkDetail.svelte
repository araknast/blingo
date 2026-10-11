<script lang="ts">
	// A fork that isn't in a bubble yet (a notagent's waits here for its pushes): why it's waiting, the
	// evidence (review, CI), then what can be done. On its own page, and in the map's drawer.
	import { atFailure } from "./atFailure";
	import { looseWhy } from "./attention";
	import Dialog from "./Dialog.svelte";
	import ForkCommands from "./ForkCommands.svelte";
	import Mark from "./Mark.svelte";
	import Markdown from "./Markdown.svelte";
	import { api } from "./session.svelte";
	import { toast, toastError } from "./toast.svelte";
	import type { RepoState } from "./types";
	import { short } from "./util";

	let { repo, fork, data, refresh }: { repo: string; fork: string; data: RepoState | null; refresh: () => unknown } = $props();

	const l = $derived(data?.loose.find((x) => x.fork === fork));
	const placing = $derived(data?.placing.includes(fork));
	const waiting = $derived(data?.waiting.includes(fork));
	const placedIn = $derived(data?.bubbles.find((b) => b.members.some((m) => m.name === fork)));
	const task = $derived(data?.tasks.find((t) => t.fork === fork));
	const ci = $derived(data?.settings.ci.enabled);
	const why = $derived(l && data ? looseWhy(l, data.settings.autoPlaceNotagents) : null);
	const reviewing = $derived(l?.reviewManual === "pending");
	const canPlace = $derived(
		!!l && (!ci || (l.ci === "passed" && l.reviewAuto !== "pending" && l.reviewAuto !== "rejected" && l.reviewManual !== "pending" && l.reviewManual !== "rejected")),
	);

	let pushed = $state<{ fork: string; clone: string; push: string } | null>(null);
	let pushOpen = $state(false);
	let note = $state("");
	let busy = $state(false);
	async function act(path: string, body?: unknown, done?: string) {
		busy = true;
		try {
			const r = await api("POST", `/repos/${repo}/forks/${fork}/${path}`, body);
			if (path === "token") ((pushed = r), (pushOpen = true));
			if (done) toast(done);
			note = "";
			await refresh();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
	const label = { running: "Running", passed: "Passed", failed: "Failed", pending: "Waiting", approved: "Approved", rejected: "Rejected" } as Record<string, string>;
	const mark = (s: string | null) => (s === "passed" || s === "approved" ? "merged" : s === "failed" || s === "rejected" ? "failed" : s === "running" ? "running" : "waiting");
</script>

<p class="kind">{l?.kind === "agent" ? "An agent's fork" : "A notagent's fork"} <span class="mono">{short(fork)}</span></p>
<h1 tabindex="-1">{task?.title ?? `Fork ${short(fork)}`}</h1>
{#if task?.description && task.description !== task.title}<details class="task"><summary>Task</summary><Markdown text={task.description} /></details>{/if}

{#if !data}
	<p class="muted">Loading…</p>
{:else if placedIn}
	<p class="callout ok"><Mark status="merged" /><span>It's placed: it joined <a href="/repos/{repo}/b/{placedIn.id}">{placedIn.name || short(placedIn.id)}</a>.</span></p>
{:else if placing}
	<p class="state"><Mark status="placing" /> Being placed in a bubble…</p>
{:else if waiting}
	<p class="state"><Mark status="waiting" /> Waiting for its first push.</p>
	<div class="actions"><button class="primary" onclick={() => act("token")} disabled={busy}>Push to it</button></div>
{:else if !l}
	<p class="muted">This fork isn't waiting to be placed. <a href="/repos/{repo}">Back to the map</a></p>
{:else}
	{#if why}
		<p class="callout" class:ok={why === "Ready to place"}><Mark status={reviewing ? "review" : why === "Ready to place" ? "merged" : "failed"} /><span>{why}</span></p>
	{/if}

	<dl>
		<dt>Pushes</dt>
		<dd>{l.pushes}</dd>
		{#if ci}
			<dt>CI</dt>
			<dd><Mark status={mark(l.ci)} /> {label[l.ci ?? ""] ?? "Not run yet"}</dd>
		{/if}
		{#if l.reviewAuto}<dt>Automatic review</dt><dd><Mark status={mark(l.reviewAuto)} /> {label[l.reviewAuto]}</dd>{/if}
		{#if l.reviewManual}<dt>Your review</dt><dd><Mark status={l.reviewManual === "pending" ? "review" : mark(l.reviewManual)} /> {label[l.reviewManual]}</dd>{/if}
	</dl>

	<p class="changes"><a href="/repos/{repo}/b/{fork}/commits">View its changes</a></p>

	{#if l.reviewNote}
		<h2>{l.reviewAuto ? "What the reviewer said" : "Review"}</h2>
		<div class="note"><Markdown text={l.reviewNote} /></div>
	{/if}
	{#if l.ciLog}
		<h2>CI output</h2>
		<pre class="log" use:atFailure>{l.ciLog}</pre>
	{/if}

	<div class="decide">
		{#if reviewing}
			<label for="review-note-{fork}">Note for the agent or person <span class="muted">(optional)</span></label>
			<textarea id="review-note-{fork}" rows="2" bind:value={note} placeholder="What to change, if you reject it"></textarea>
			<div class="actions">
				<button class="primary" disabled={busy} onclick={() => act("review", { approve: true, comment: note }, "Approved")}>Approve</button>
				<button disabled={busy} onclick={() => act("review", { approve: false, comment: note }, "Rejected")}>Reject</button>
			</div>
		{:else}
			<div class="actions">
				{#if canPlace}<button class="primary" disabled={busy} onclick={() => act("place", undefined, "Placing it")}>Place it</button>{/if}
				{#if l.kind === "notagent"}<button disabled={busy} onclick={() => act("token")}>Push to it</button>{/if}
			</div>
		{/if}
	</div>
{/if}

<Dialog bind:open={pushOpen} title="Push to this fork" wide>
	{#if pushed}<ForkCommands {pushed} />{/if}
</Dialog>

<style>
	.kind { font-size: 0.8125rem; color: var(--ink-3); }
	.kind .mono { font-size: 0.75rem; }
	h1 { margin: 0.2rem 0 1rem; overflow-wrap: anywhere; }
	h2 { font-size: 0.9375rem; margin: 1.5rem 0 0.5rem; }
	.task { margin-bottom: 1.25rem; border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--raised); }
	.task summary { cursor: pointer; padding: 0.45rem 0.75rem; font-size: 0.875rem; color: var(--ink-2); }
	.task :global(.md) { padding: 0.25rem 1rem 0.5rem; }
	.state { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
	.callout { margin-bottom: 1rem; }
	dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0 0 0.75rem; }
	dt { color: var(--ink-2); }
	dd { margin: 0; display: flex; align-items: center; gap: 0.4rem; }
	.changes { font-size: 0.875rem; }
	.note { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); padding: 0.25rem 1rem; max-height: 24rem; overflow: auto; }
	.log { max-height: 22rem; overflow: auto; margin: 0; padding: 0.75rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-md); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.75rem; line-height: 1.5; }
	.decide { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--line-2); display: grid; gap: 0.4rem; }
	.decide label { font-size: 0.875rem; font-weight: 500; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.25rem; }
</style>
