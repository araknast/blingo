<script lang="ts">
	import { onDestroy } from "svelte";
	import BubbleMap from "../lib/BubbleMap.svelte";
	import ContextMenu, { type MenuItem } from "../lib/ContextMenu.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import ForkCommands from "../lib/ForkCommands.svelte";
	import RepoTabs from "../lib/RepoTabs.svelte";
	import Shell from "../lib/Shell.svelte";
	import SuperagentDialog from "../lib/SuperagentDialog.svelte";
	import { navigate } from "../lib/router.svelte";
	import { ApiError, api, loadMe } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { RepoState } from "../lib/types";
	import { agentLabel, ago, duration, menuGesture, plural, poll, short } from "../lib/util";

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

	// ---- Right-click menu: on a bubble, its actions; on the background, the general ones ----
	let menu = $state<{ x: number; y: number; bubble: string | null } | null>(null);
	// Set when a dialog was opened from a bubble's menu; the dialog then starts from that bubble.
	let fixedBase = $state<string | null>(null);

	function openAgent(bubble: string | null) {
		fixedBase = bubble;
		agentBase = bubble ?? "";
		agentOpen = true;
	}
	function openPush(bubble: string | null) {
		fixedBase = bubble;
		pushBase = bubble ?? "";
		pushOpen = true;
	}
	const menuItems = $derived.by((): MenuItem[] => {
		if (!menu) return [];
		const b = menu.bubble && data?.bubbles.find((x) => x.id === menu!.bubble);
		if (!b) return [
			{ label: "Start an agent", action: () => openAgent(null) },
			{ label: "Plan tasks with a superagent", action: () => openSuper(null) },
			{ label: "Push a fork", action: () => openPush(null) },
		];
		return [
			{ label: "Start an agent from this bubble", action: () => openAgent(b.id) },
			{ label: "Plan tasks from this bubble", action: () => openSuper(b.id) },
			{ label: "Push a fork from this bubble", action: () => openPush(b.id) },
			{ label: b.locked ? "Unlock bubble" : "Lock bubble", action: () => setLock(b.id, !b.locked) },
			{ label: "Browse code", action: () => navigate(bubbleHref(b.id)) },
		];
	});

	// ---- Start an agent ----
	let agentOpen = $state(false);
	let agentTitle = $state("");
	let prompt = $state("");
	let agentBase = $state("");
	let busy = $state(false);
	async function startAgent(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", "/agents", { repo, title: agentTitle, prompt, bubble: agentBase || undefined });
			agentOpen = false;
			agentTitle = prompt = "";
			toast("Agent started. Its task is on the Tasks tab.");
			refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	// ---- Superagent: plans a prompt into tasks ----
	let superOpen = $state(false);
	function openSuper(bubble: string | null) {
		fixedBase = bubble;
		superOpen = true;
	}

	// ---- Push a fork (notagent) ----
	let pushOpen = $state(false);
	let pushBase = $state("");
	let pushTitle = $state("");
	let pushDescription = $state("");
	let pushed = $state<{ fork: string; clone: string; push: string } | null>(null);
	async function createFork(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			pushed = await api("POST", "/notagents", { repo, title: pushTitle, description: pushDescription || pushTitle, bubble: pushBase || undefined });
			pushTitle = pushDescription = "";
			refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	// ---- Loose forks: pushed notagent forks waiting to be placed ----
	async function placeLoose(fork: string) {
		try {
			await api("POST", `/repos/${repo}/forks/${fork}/place`);
			toast(`Placing ${short(fork)}`);
			refresh();
		} catch (e) {
			toastError(e);
		}
	}
	async function pushAgain(fork: string) {
		try {
			pushed = await api("POST", `/repos/${repo}/forks/${fork}/token`);
			fixedBase = null;
			pushOpen = true;
		} catch (e) {
			toastError(e);
		}
	}
	async function setAutoPlace(on: boolean) {
		try {
			await api("PUT", `/repos/${repo}/settings`, { autoPlaceNotagents: on });
			refresh();
		} catch (e) {
			toastError(e);
		}
	}

	// ---- Memory ----
	let note = $state("");
	async function addNote(e: SubmitEvent) {
		e.preventDefault();
		try {
			await api("POST", `/repos/${repo}/memory`, { text: note });
			note = "";
			refresh();
		} catch (err) {
			toastError(err);
		}
	}
	async function deleteNote(id: string) {
		try {
			await api("DELETE", `/repos/${repo}/memory/${id}`);
			refresh();
		} catch (err) {
			toastError(err);
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
	{#if missing}
		<div class="missing">
			<h1>This repository isn't available</h1>
			<p>It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		</div>
	{:else}
		<div class="page">
		<RepoTabs {repo} current="map" open={data?.tasks.filter((t) => t.status !== "completed").length} />
		<div class="layout">
			<section class="stage" aria-label="Bubble map">
				<BubbleMap {data} hrefFor={bubbleHref} onconflict={askFerge} oncontext={(at) => (menu = at)} />
			</section>

			<aside class="rail">
				<section>
					<h2>Agents <span class="count">{working ? `${working} working` : ""}</span></h2>
					{#if !data?.agents.length}
						<p class="muted small">No agents yet. {menuGesture} the map to start one.</p>
					{:else}
						<ul class="agents">
							{#each data.agents as a (a.fork)}
								<li>
									<div class="agent-head">
										<span class="status {a.status}"><i class="dot {a.status === 'running' ? 'working pulse' : a.status === 'placed' ? 'merged' : 'conflict'}"></i>{agentLabel(a.status)}</span>
										<span class="muted small">{a.finished ? `took ${duration(a.finished - a.started)}` : `started ${ago(a.started)}`}</span>
									</div>
									<p class="prompt">{#if a.fork.includes("-s-")}<span class="kind">Superagent</span> {/if}{a.prompt}</p>
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
									<span class="muted small">{plural(b.members.length, "fork")}{b.visible ? "" : ", merging"}{b.locked ? ", locked" : ""}</span>
								</span>
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

				{#if data?.loose.length}
					<section>
						<h2>Pushed, not placed <span class="count">{data.loose.length}</span></h2>
						<p class="muted small">Human forks wait here until you place them. Push to one again first if its placement failed.</p>
						<ul class="rows">
							{#each data.loose as l (l.fork)}
								<li>
									<span>
										<span class="mono">{short(l.fork)}</span>
										<span class="muted small">{plural(l.pushes, "push", "pushes")}{l.reason ? `, not placed: ${l.reason}` : ""}</span>
									</span>
									<span class="row">
										<button onclick={() => pushAgain(l.fork)}>Push</button>
										<button onclick={() => placeLoose(l.fork)}>Place</button>
									</span>
								</li>
							{/each}
						</ul>
					</section>
				{/if}

				{#if data}
					<section>
						<label class="choice"><input type="checkbox" checked={data.settings.autoPlaceNotagents} onchange={(e) => setAutoPlace(e.currentTarget.checked)} /> Place human forks as soon as they're pushed</label>
					</section>
				{/if}

				<section>
					<h2>Memory <span class="count">{data?.memory.length || ""}</span></h2>
					<p class="muted small">Every agent working on this repository reads these notes, and can add its own.</p>
					<ul class="rows notes">
						{#each data?.memory ?? [] as m (m.id)}
							<li>
								<span>{m.text}</span>
								<button class="quiet" aria-label="Delete note" onclick={() => deleteNote(m.id)}>×</button>
							</li>
						{/each}
					</ul>
					<form class="add-note" onsubmit={addNote}>
						<input aria-label="New note" bind:value={note} placeholder="Add a note for agents" required />
						<button>Add</button>
					</form>
				</section>

				<section class="danger-zone">
					<button class="quiet danger" onclick={() => (deleteOpen = true)}>Delete repository</button>
				</section>
			</aside>
		</div>
		</div>
	{/if}
</Shell>

<Dialog bind:open={agentOpen} title="Start an agent">
	<form onsubmit={startAgent}>
		<div class="field">
			<label for="agent-title">Title</label>
			<input id="agent-title" bind:value={agentTitle} required maxlength="60" placeholder="Add a dark mode toggle" />
		</div>
		<div class="field">
			<label for="prompt">What should it do?</label>
			<textarea id="prompt" bind:value={prompt} required placeholder="Add a dark mode toggle to the settings page"></textarea>
		</div>
		<div class="field">
			{@render base("agent-base", "The agent works on a fork of this bubble's code. When it finishes, its fork joins whichever bubble it fits.")}
		</div>
		<button class="primary" disabled={busy}>Start agent</button>
	</form>
</Dialog>

<SuperagentDialog bind:open={superOpen} {repo} bubbles={data?.bubbles ?? []} {fixedBase} onstarted={refresh} />

<Dialog bind:open={pushOpen} title="Push a fork" wide>
	{#if !pushed}
		<form onsubmit={createFork}>
			<p class="intro">Get a fork to push your own commits to. Once you push, yorkle places it in a bubble like any agent's work.</p>
			<div class="field">
				<label for="push-title">Title</label>
				<input id="push-title" bind:value={pushTitle} required maxlength="60" placeholder="Fix the login redirect" />
			</div>
			<div class="field">
				<label for="push-description">Description <span class="muted">(optional)</span></label>
				<textarea id="push-description" bind:value={pushDescription} placeholder="What you'll change and why"></textarea>
			</div>
			<div class="field">{@render base("push-base")}</div>
			<button class="primary" disabled={busy}>Create fork</button>
		</form>
	{:else}
		<ForkCommands {pushed} />
	{/if}
</Dialog>

<!-- "Start from": fixed when the dialog came from a bubble's menu, otherwise a choice. -->
{#snippet base(id: string, hint?: string)}
	{#if fixedBase}
		<p class="from">Starts from bubble <span class="mono">{short(fixedBase)}</span></p>
	{:else}
		<label for={id}>Start from</label>
		{#if id === "agent-base"}
			<select {id} bind:value={agentBase}>
				<option value="">Any bubble</option>
				{#each data?.bubbles ?? [] as b}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
			</select>
		{:else}
			<select {id} bind:value={pushBase}>
				<option value="">Any bubble</option>
				{#each data?.bubbles ?? [] as b}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
			</select>
		{/if}
	{/if}
	{#if hint}<p class="hint">{hint}</p>{/if}
{/snippet}

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		title={menu.bubble && data?.bubbles.some((b) => b.id === menu!.bubble) ? `Bubble ${short(menu.bubble)}` : undefined}
		items={menuItems}
		onclose={() => (menu = null)}
	/>
{/if}

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
	.page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
	.layout { display: grid; grid-template-columns: 1fr 320px; flex: 1; min-height: 0; }
	.stage { min-width: 0; min-height: 0; position: relative; }
	.rail { border-left: 1px solid var(--line); background: var(--paper); overflow-y: auto; min-height: 0; }
	.rail section { padding: 1.1rem 1.25rem; border-bottom: 1px solid var(--line-2); }
	.rail h2 { font-size: 0.9375rem; margin-bottom: 0.6rem; display: flex; align-items: baseline; gap: 0.5rem; }
	.count { font-weight: 400; color: var(--ink-3); font-size: 0.8125rem; }
	.small { font-size: 0.8125rem; }

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
	.danger-zone { border-bottom: 0 !important; }

	.kind { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-3); margin-right: 0.25rem; }
	.notes li { align-items: flex-start; }
	.notes li span { padding-top: 0.35rem; overflow-wrap: anywhere; }
	.add-note { display: flex; gap: 0.4rem; margin-top: 0.6rem; }
	.add-note input { flex: 1; min-width: 0; }

	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	.intro .mono { color: var(--ink); }
	.from { font-size: 0.875rem; color: var(--ink-2); }
	.from .mono { color: var(--ink); }
	.row { display: flex; gap: 0.5rem; }
	.choice { display: flex; gap: 0.5rem; align-items: center; font-size: 0.875rem; }
	.choice input { width: auto; }
	.delete { background: var(--conflict); border-color: var(--conflict); color: #fff; }
	.missing { padding: 2rem clamp(1rem, 3vw, 2.5rem); }
	.missing p { margin-top: 0.75rem; color: var(--ink-2); }

	@media (max-width: 900px) {
		.page { height: auto; }
		.layout { grid-template-columns: 1fr; grid-template-rows: 62vh auto; height: auto; }
		.rail { border-left: 0; border-top: 1px solid var(--line); overflow: visible; }
	}
</style>
