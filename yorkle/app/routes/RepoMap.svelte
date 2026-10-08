<script lang="ts">
	import { onDestroy } from "svelte";
	import BubbleMap from "../lib/BubbleMap.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import Shell from "../lib/Shell.svelte";
	import { navigate } from "../lib/router.svelte";
	import { ApiError, api, loadMe } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { RepoState } from "../lib/types";
	import { agentLabel, ago, copy, duration, plural, poll, short } from "../lib/util";

	let { repo }: { repo: string } = $props();

	let data = $state<RepoState | null>(null);
	let missing = $state(false);

	async function refresh() {
		try {
			data = await api<RepoState>("GET", `/repos/${repo}`);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) missing = true;
			else if (!data) toastError(e);
		}
	}
	const stop = poll(refresh, 2500);
	onDestroy(stop);

	const working = $derived(data?.agents.filter((a) => a.status === "running").length ?? 0);
	const bubbleHref = (id: string) => `/repos/${repo}/b/${id}`;

	// ---- Start an agent ----
	let agentOpen = $state(false);
	let prompt = $state("");
	let agentBase = $state("");
	let busy = $state(false);
	async function startAgent(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", "/agents", { repo, prompt, bubble: agentBase || undefined });
			agentOpen = false;
			prompt = "";
			toast("Agent started. It appears in the dock until its fork lands in a bubble.");
			refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	// ---- Push a fork (notagent) ----
	let pushOpen = $state(false);
	let pushBase = $state("");
	let pushed = $state<{ fork: string; push: string } | null>(null);
	async function createFork(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			pushed = await api("POST", "/notagents", { repo, bubble: pushBase || undefined });
			refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	$effect(() => {
		if (!pushOpen) pushed = null;
	});

	// ---- Lock, ferge, delete ----
	async function setLock(id: string, lock: boolean) {
		try {
			await api("POST", `/repos/${repo}/${lock ? "lock" : "unlock"}`, { bubble: id });
			toast(lock ? `Locked bubble ${short(id)}` : `Unlocked bubble ${short(id)}`);
			refresh();
		} catch (e) {
			toastError(e);
		}
	}

	let fergePair = $state<[string, string] | null>(null);
	let fergeOpen = $state(false);
	const askFerge = (a: string, b: string) => ((fergePair = [a, b]), (fergeOpen = true));
	async function ferge() {
		if (!fergePair) return;
		busy = true;
		try {
			const r = await api<{ locked: string; files: string[] }>("POST", `/repos/${repo}/ferge`, { a: fergePair[0], b: fergePair[1] });
			fergeOpen = false;
			toast(`Ferged. Bubble ${short(r.locked)} holds ${plural(r.files.length, "conflicting file")}.`);
			refresh();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	let deleteOpen = $state(false);
	let confirmName = $state("");
	async function destroy(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("DELETE", `/repos/${repo}`);
			await loadMe();
			toast(`Deleted ${repo}`);
			navigate("/repos");
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Shell crumbs={[{ label: "Repositories", href: "/repos" }, { label: repo, mono: true }]} {repo} full>
	{#snippet actions()}
		{#if !missing}
			<button onclick={() => (pushOpen = true)}>Push a fork</button>
			<button class="primary" onclick={() => (agentOpen = true)}>Start agent</button>
		{/if}
	{/snippet}

	{#if missing}
		<div class="missing">
			<h1>This repository isn't available</h1>
			<p>It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		</div>
	{:else}
		<div class="layout">
			<section class="stage" aria-label="Bubble map">
				<BubbleMap {data} hrefFor={bubbleHref} onconflict={askFerge} />
			</section>

			<aside class="rail">
				<section>
					<h2>Agents <span class="count">{working ? `${working} working` : ""}</span></h2>
					{#if !data?.agents.length}
						<p class="muted small">No agents yet. <button class="link" onclick={() => (agentOpen = true)}>Start one</button></p>
					{:else}
						<ul class="agents">
							{#each data.agents as a (a.fork)}
								<li>
									<div class="agent-head">
										<span class="status {a.status}"><i class="dot {a.status === 'running' ? 'working pulse' : a.status === 'placed' ? 'merged' : 'conflict'}"></i>{agentLabel(a.status)}</span>
										<span class="muted small">{a.finished ? `took ${duration(a.finished - a.started)}` : `started ${ago(a.started)}`}</span>
									</div>
									<p class="prompt">{a.prompt}</p>
									{#if a.log}
										<details><summary>Log</summary><pre>{a.log}</pre></details>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				{#if data?.conflicts.length}
					<section>
						<h2>Conflicts <span class="count">{data.conflicts.length}</span></h2>
						<p class="muted small">These bubbles change the same files in ways git can't merge.</p>
						<ul class="rows">
							{#each data.conflicts as [a, b] (a + b)}
								<li>
									<span><i class="dot conflict"></i> <a class="mono" href={bubbleHref(a)}>{short(a)}</a> and <a class="mono" href={bubbleHref(b)}>{short(b)}</a></span>
									<button onclick={() => askFerge(a, b)}>Ferge</button>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				<section>
					<h2>Bubbles <span class="count">{data?.bubbles.length ?? ""}</span></h2>
					{#if data && !data.bubbles.length}<p class="muted small">None yet.</p>{/if}
					<ul class="rows">
						{#each data?.bubbles ?? [] as b (b.id)}
							<li>
								<span>
									<a class="mono" href={bubbleHref(b.id)}>{short(b.id)}</a>
									<span class="muted small">{plural(b.members.length, "fork")}{b.visible ? "" : ", merging"}</span>
								</span>
								<button class="quiet small-btn" onclick={() => setLock(b.id, !b.locked)} aria-label="{b.locked ? 'Unlock' : 'Lock'} bubble {short(b.id)}">
									{b.locked ? "Unlock" : "Lock"}
								</button>
							</li>
						{/each}
					</ul>
				</section>

				{#if data?.waiting.length}
					<section>
						<h2>Waiting for a push <span class="count">{data.waiting.length}</span></h2>
						<p class="muted small">Push tokens last an hour. Forks with no push by then are deleted.</p>
						<ul class="rows">
							{#each data.waiting as f (f)}<li><span class="mono">{short(f)}</span></li>{/each}
						</ul>
					</section>
				{/if}

				<section class="danger-zone">
					<button class="quiet danger" onclick={() => (deleteOpen = true)}>Delete repository</button>
				</section>
			</aside>
		</div>
	{/if}
</Shell>

<Dialog bind:open={agentOpen} title="Start an agent">
	<form onsubmit={startAgent}>
		<div class="field">
			<label for="prompt">What should it do?</label>
			<textarea id="prompt" bind:value={prompt} required placeholder="Add a dark mode toggle to the settings page"></textarea>
		</div>
		<div class="field">
			<label for="agent-base">Start from</label>
			<select id="agent-base" bind:value={agentBase}>
				<option value="">Any bubble</option>
				{#each data?.bubbles ?? [] as b}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
			</select>
			<p class="hint">The agent works on a fork of this bubble's code. When it finishes, its fork joins whichever bubble it fits.</p>
		</div>
		<button class="primary" disabled={busy}>Start agent</button>
	</form>
</Dialog>

<Dialog bind:open={pushOpen} title="Push a fork" wide>
	{#if !pushed}
		<form onsubmit={createFork}>
			<p class="intro">Get a fork to push your own commits to. Once you push, yorkle places it in a bubble like any agent's work.</p>
			<div class="field">
				<label for="push-base">Start from</label>
				<select id="push-base" bind:value={pushBase}>
					<option value="">Any bubble</option>
					{#each data?.bubbles ?? [] as b}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
				</select>
			</div>
			<button class="primary" disabled={busy}>Create fork</button>
		</form>
	{:else}
		<p class="intro">Fork <span class="mono">{short(pushed.fork)}</span> is ready. Push to it from your checkout within the hour:</p>
		<div class="cmd">
			<pre>{pushed.push}</pre>
			<button onclick={() => copy(pushed!.push).then(() => toast("Push command copied"))}>Copy</button>
		</div>
		<p class="hint">The command holds a write token for this fork only. Only your first push counts.</p>
	{/if}
</Dialog>

<Dialog bind:open={fergeOpen} title="Ferge these bubbles?">
	{#if fergePair}
		<p class="intro">
			Bubbles <span class="mono">{short(fergePair[0])}</span> and <span class="mono">{short(fergePair[1])}</span> merge, without the files they conflict on.
			A new locked bubble holds those files with conflict markers. Fix them in a fork of that bubble, then unlock it to merge the fix back.
		</p>
		<div class="row">
			<button class="primary" onclick={ferge} disabled={busy}>Ferge bubbles</button>
			<button onclick={() => (fergeOpen = false)}>Cancel</button>
		</div>
	{/if}
</Dialog>

<Dialog bind:open={deleteOpen} title="Delete this repository?">
	<form onsubmit={destroy}>
		<p class="intro">This deletes every bubble, fork and agent record in <span class="mono">{repo}</span>. It can't be undone.</p>
		<div class="field">
			<label for="confirm">Type <span class="mono">{repo}</span> to confirm</label>
			<input id="confirm" autocomplete="off" bind:value={confirmName} />
		</div>
		<button class="primary delete" disabled={busy || confirmName !== repo}>Delete repository</button>
	</form>
</Dialog>

<style>
	.layout { display: grid; grid-template-columns: 1fr 320px; height: 100%; min-height: 0; }
	.stage { min-width: 0; min-height: 0; position: relative; }
	.rail { border-left: 1px solid var(--line); background: var(--paper); overflow-y: auto; min-height: 0; }
	.rail section { padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--line-2); }
	.rail h2 { font-size: 0.9375rem; margin-bottom: 0.6rem; display: flex; align-items: baseline; gap: 0.5rem; }
	.count { font-weight: 400; color: var(--ink-3); font-size: 0.8125rem; }
	.small { font-size: 0.8125rem; }
	.link { background: none; border: 0; padding: 0; color: inherit; text-decoration: underline; font-size: inherit; }

	.agents { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.9rem; }
	.agent-head { display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; }
	.status { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.8125rem; font-weight: 500; }
	.prompt { margin-top: 0.25rem; font-size: 0.875rem; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
	details { margin-top: 0.35rem; font-size: 0.8125rem; }
	summary { cursor: pointer; color: var(--ink-2); }
	details pre { max-height: 16rem; overflow: auto; padding: 0.6rem; margin: 0.4rem 0 0; background: var(--fog); border-radius: var(--r-sm); white-space: pre-wrap; font-size: 0.75rem; }

	.rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.15rem; }
	.rows li { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; min-height: 2rem; font-size: 0.875rem; }
	.rows a { text-decoration: none; }
	.rows a:hover { text-decoration: underline; }
	.rows .mono { font-size: 0.8125rem; }
	.rows .muted { margin-left: 0.4rem; }
	.small-btn { padding: 0.2rem 0.5rem; font-size: 0.8125rem; }
	.danger-zone { border-bottom: 0 !important; }

	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	.intro .mono { color: var(--ink); }
	.cmd { display: flex; gap: 0.5rem; align-items: flex-start; }
	.cmd pre { flex: 1; margin: 0; padding: 0.7rem 0.8rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); white-space: pre-wrap; word-break: break-all; }
	.row { display: flex; gap: 0.5rem; }
	.delete { background: var(--conflict); border-color: var(--conflict); color: #fff; }
	.missing { padding: 2rem clamp(1rem, 3vw, 2.5rem); }
	.missing p { margin-top: 0.75rem; color: var(--ink-2); }

	@media (max-width: 900px) {
		.layout { grid-template-columns: 1fr; grid-template-rows: 62vh auto; height: auto; }
		.rail { border-left: 0; border-top: 1px solid var(--line); overflow: visible; }
	}
</style>
