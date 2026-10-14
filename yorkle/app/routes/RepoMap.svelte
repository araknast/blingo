<script lang="ts">
	import BubbleMap from "../lib/BubbleMap.svelte";
	import ContextMenu, { type MenuItem } from "../lib/ContextMenu.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import SkillPicker from "../lib/SkillPicker.svelte";
	import ModelField from "../lib/ModelField.svelte";
	import ForkCommands from "../lib/ForkCommands.svelte";
	import BubbleView from "../lib/BubbleView.svelte";
	import ForkDetail from "../lib/ForkDetail.svelte";
	import Shell from "../lib/Shell.svelte";
	import AgentView from "./agents/AgentView.svelte";
	import TaskGraph from "../lib/TaskGraph.svelte";
	import TaskView, { type TaskLinks } from "./tasks/TaskView.svelte";
	import SuperagentDialog from "../lib/SuperagentDialog.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { navigate, route } from "../lib/router.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import { ferge as fergeBubbles, fergeFiles as filesBoth, setLock as lockBubble } from "../lib/bubbleActions";
	import { plural, repoName, runKind, short } from "../lib/util";

	let { repo }: { repo: string } = $props();

	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const repoData = repoState(repo, 2500);
	const data = $derived(repoData.data);
	const refresh = repoData.refresh;
	const bubbleName = (id: string) => data?.bubbles.find((b) => b.id === id)?.name || short(id);
	let map = $state<ReturnType<typeof BubbleMap>>();
	// The stage shows the bubble map or the task graph; the choice is remembered per browser.
	const VIEW = "yorkle.mapView";
	let view = $state<"bubbles" | "tasks">((() => { try { return localStorage.getItem(VIEW) === "tasks" ? "tasks" : "bubbles"; } catch { return "bubbles"; } })());
	function show(v: "bubbles" | "tasks") {
		view = v;
		try { localStorage.setItem(VIEW, v); } catch {}
	}

	// ---- Drawer: a run, a fork or a task opens beside the map (?d=run:<fork>, fork:<fork>, task:<id>) ----
	const drawer = $derived.by(() => {
		const d = new URLSearchParams(route.search).get("d");
		const i = d?.indexOf(":") ?? -1;
		return d && i > 0 ? { kind: d.slice(0, i), id: d.slice(i + 1) } : null;
	});
	const open = (kind: string, id: string) => `/repos/${repo}?d=${kind}:${encodeURIComponent(id)}`;
	const links: TaskLinks = { task: (id) => open("task", id), run: (f) => open("run", f), fork: (f) => open("fork", f) };
	// A bubble's code view keeps its own path in `p` ("/src/a/b?at=…"), so its links stay in the drawer.
	const bubbleRest = $derived.by(() => {
		const p = (new URLSearchParams(route.search).get("p") ?? "").replace(/^\//, "");
		const [rest, q] = p.split("?");
		return { rest, at: new URLSearchParams(q ?? "").get("at") ?? undefined };
	});
	const bubbleBase = (id: string) => `${open("bubble", id)}&p=`;
	const fullPage = $derived(
		!drawer
			? ""
			: drawer.kind === "run"
				? `/repos/${repo}/agents/${drawer.id}`
				: drawer.kind === "fork"
					? `/repos/${repo}/forks/${drawer.id}`
					: drawer.kind === "bubble"
						? `/repos/${repo}/b/${drawer.id}/${bubbleRest.rest}${bubbleRest.at ? `?at=${bubbleRest.at}` : ""}`
						: `/repos/${repo}/tasks/${drawer.id}`,
	);
	const drawerTask = $derived(drawer?.kind === "task" ? data?.tasks.find((t) => t.id === drawer.id) : undefined);
	const drawerRun = $derived(drawer?.kind === "run" ? data?.agents.find((a) => a.fork === drawer.id) : undefined);
	const closeDrawer = () => navigate(`/repos/${repo}`);
	let drawerEl = $state<HTMLElement>();
	$effect(() => {
		if (drawer) drawerEl?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
	});
	function drawerKeys(e: KeyboardEvent) {
		if (e.key === "Escape" && drawer && !document.querySelector("dialog[open]")) closeDrawer();
	}

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
			{ label: "Browse code", action: () => navigate(bubbleBase(b.id)) },
			...(data?.settings.deploys.length ? [{ label: "Deploy this bubble…", action: () => navigate(`/repos/${repo}/deploy?bubble=${encodeURIComponent(b.id)}`) }] : []),
		];
	});

	// ---- Start an agent ----
	let agentOpen = $state(false);
	let agentTitle = $state("");
	let prompt = $state("");
	let agentBase = $state("");
	let agentModel = $state("");
	let agentSkills = $state<string[] | undefined>(undefined);
	let busy = $state(false);
	async function startAgent(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", "/agents", { repo, title: agentTitle, prompt, bubble: agentBase || undefined, model: agentModel.trim() || undefined, skills: agentSkills });
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
			const r = await api("POST", "/notagents", { repo, title: pushTitle, description: pushDescription || pushTitle, bubble: pushBase || undefined });
			pushTitle = pushDescription = "";
			pushed = r;
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

	// ---- Lock, ferge ----
	async function setLock(id: string, lock: boolean) {
		if (await lockBubble(repo, data, id, lock)) refresh();
	}

	let fergePair = $state<[string, string] | null>(null);
	let fergeOpen = $state(false);
	const askFerge = (a: string, b: string) => ((fergePair = [a, b]), (fergeOpen = true));
	// The files both bubbles changed: what the ferge's locked bubble will hold.
	const fergeFiles = $derived(fergePair ? filesBoth(data, fergePair[0], fergePair[1]) : []);
	async function ferge() {
		if (!fergePair) return;
		busy = true;
		const locked = await fergeBubbles(repo, data, fergePair[0], fergePair[1]);
		busy = false;
		if (!locked) return;
		fergeOpen = false;
		await refresh();
		map?.focusOn([locked]);
	}
</script>

<svelte:window onkeydown={drawerKeys} />

{#snippet viewToggle()}
	<div class="views" role="group" aria-label="View">
		<button aria-pressed={view === "bubbles"} onclick={() => show("bubbles")}>
			<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="5" cy="8.5" r="3.5" /><circle cx="10.5" cy="4.5" r="2.5" /></svg>Bubbles!
		</button>
		<button aria-pressed={view === "tasks"} onclick={() => show("tasks")}>
			<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="5" height="3.5" rx="1" /><rect x="7.5" y="9" width="5" height="3.5" rx="1" /><path d="M4 5v2.5c0 1 .5 1.5 1.5 1.5h2" /></svg>Tasks
		</button>
	</div>
{/snippet}

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names) }]}
	{repo}
	data={data}
	full
>
	{#if repoData.missing}
		<div class="missing">
			<h1>This repository isn't available</h1>
			<p>It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		</div>
	{:else}
		<section class="stage" class:drawn={!!drawer} aria-label={view === "tasks" ? "Task graph" : "Bubble map"}>
			{#if view === "tasks"}
				<TaskGraph {data} href={(id) => open("task", id)} current={drawer?.kind === "task" ? drawer.id : undefined} controls={viewToggle} />
			{:else}
				<BubbleMap
					bind:this={map}
					{data}
					stale={repoData.stale}
					taskHref={(id) => open("task", id)}
					pageHref={(tab) => `/repos/${repo}/${tab}`}
					hrefFor={(id, rest = "") => bubbleBase(id) + (rest ? `/${rest}` : "")}
					agentHref={(fork) => open("run", fork)}
					looseHref={(fork) => open("fork", fork)}
					onconflict={askFerge}
					oncontext={(at) => (menu = at)}
					controls={viewToggle}
				/>
			{/if}
			{#if drawer}
				<aside class="drawer" bind:this={drawerEl} aria-label="Details">
					<header class="drawer-bar">
						<a href={fullPage}>Open full page</a>
						<a class="close" href="/repos/{repo}" aria-label="Close">
							<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 3l8 8M11 3l-8 8" /></svg>
						</a>
					</header>
					<div class="drawer-body">
						{#key route.search}
							{#if drawer.kind === "run"}
								<AgentView {repo} id={drawer.id} run={drawerRun} task={data?.tasks.find((t) => t.kind === "agent" && t.status === "in-progress" && t.fork === drawer.id)?.id} kind={runKind(drawerRun ?? { fork: drawer.id })} {data} forkHref={(f) => open("fork", f)} taskHref={(t) => open("task", t)} bubbleHref={(b) => open("bubble", b)} />
							{:else if drawer.kind === "bubble"}
								<BubbleView {repo} bubble={drawer.id} rest={bubbleRest.rest} at={bubbleRest.at} base={bubbleBase(drawer.id)} {data} {refresh} />
							{:else if drawer.kind === "fork"}
								<ForkDetail {repo} fork={drawer.id} {data} {refresh} />
							{:else if drawerTask && data}
								<TaskView task={drawerTask} {data} {repo} {refresh} {links} ongone={closeDrawer} />
							{:else}
								<p class="muted">{data ? "That task is gone: it was rejected, or never existed." : "Loading…"}</p>
							{/if}
						{/key}
					</div>
				</aside>
			{/if}
		</section>
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
		<div class="field"><ModelField id="agent-model" bind:value={agentModel} /></div>
		<SkillPicker skills={data?.skills ?? []} bind:chosen={agentSkills} />
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
		<p class="from">Starts from bubble <span>{bubbleName(fixedBase)}</span></p>
	{:else}
		<label for={id}>Start from</label>
		{#if id === "agent-base"}
			<select {id} bind:value={agentBase}>
				<option value="">Any bubble</option>
				{#each data?.bubbles ?? [] as b}<option value={b.id}>{b.name || short(b.id)}</option>{/each}
			</select>
		{:else}
			<select {id} bind:value={pushBase}>
				<option value="">Any bubble</option>
				{#each data?.bubbles ?? [] as b}<option value={b.id}>{b.name || short(b.id)}</option>{/each}
			</select>
		{/if}
	{/if}
	{#if hint}<p class="hint">{hint}</p>{/if}
{/snippet}

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		title={menu.bubble && data?.bubbles.some((b) => b.id === menu!.bubble) ? bubbleName(menu.bubble) : undefined}
		items={menuItems}
		onclose={() => (menu = null)}
	/>
{/if}

<Dialog bind:open={fergeOpen} title="Ferge these bubbles?">
	{#if fergePair}
		<p class="intro">
			<strong>{bubbleName(fergePair[0])}</strong> and <strong>{bubbleName(fergePair[1])}</strong> merge, without the files they conflict on.
			A new locked bubble holds those files with conflict markers. Fix them in a fork of that bubble, then unlock it to merge the fix back.
		</p>
		{#if fergeFiles.length}
			<p class="files-head">{plural(fergeFiles.length, "file")} they both changed</p>
			<ul class="files">
				{#each fergeFiles.slice(0, 8) as f}<li><code>{f}</code></li>{/each}
				{#if fergeFiles.length > 8}<li class="muted">and {fergeFiles.length - 8} more</li>{/if}
			</ul>
		{/if}
		<div class="row">
			<button class="primary" onclick={ferge} disabled={busy}>Ferge bubbles</button>
			<button onclick={() => (fergeOpen = false)}>Cancel</button>
		</div>
	{/if}
</Dialog>


<style>
	.stage { height: 100%; min-height: 0; position: relative; }
	.drawn :global(#map-card) { display: none; } /* a bubble's hover card would sit beside the drawer */
	.drawer {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: min(44rem, 100%);
		display: flex;
		flex-direction: column;
		background: var(--fog);
		border-left: 1px solid var(--line);
		box-shadow: -12px 0 32px rgb(15 24 33 / 0.12);
		z-index: 8;
		animation: slide 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@keyframes slide { from { translate: 2rem 0; opacity: 0; } }
	@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
	/* On a narrow screen the map is only part of the page: the drawer takes the whole screen. */
	@media (max-width: 900px) { .drawer { position: fixed; top: 3.5rem; left: 0; width: 100%; border-left: 0; z-index: 30; } }
	.drawer-bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 0.75rem 0.6rem 1.25rem; border-bottom: 1px solid var(--line-2); background: var(--paper); font-size: 0.875rem; }
	.close { display: grid; place-items: center; width: 2rem; height: 2rem; border-radius: var(--r-sm); color: var(--ink-2); }
	.close:hover { background: var(--line-2); color: var(--ink); }
	.close path { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
	.drawer-body { flex: 1; overflow-y: auto; padding: 1.25rem 1.5rem 2rem; }
	.drawer-body :global(h1) { font-size: 1.375rem; outline: none; }
	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	.from { font-size: 0.875rem; color: var(--ink-2); }
	.from span { color: var(--ink); }
	.row { display: flex; gap: 0.5rem; }
	.files-head { font-size: 0.875rem; font-weight: 600; margin-bottom: 0.35rem; }
	.files { list-style: none; margin: 0 0 1.25rem; padding: 0.5rem 0.75rem; display: grid; gap: 0.15rem; background: var(--fog); border-radius: var(--r-sm); }
	.files code { font-size: 0.8125rem; overflow-wrap: anywhere; }
	/* The view toggle, first in the stage's top bar: a segmented control. */
	.views { pointer-events: auto; display: flex; padding: 2px; gap: 2px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); box-shadow: 0 2px 8px rgb(15 24 33 / 0.06); }
	.views button { gap: 0.35rem; padding: 0.2rem 0.6rem 0.2rem 0.5rem; border: 0; background: none; font-size: 0.875rem; color: var(--ink-2); }
	.views button:hover { color: var(--ink); background: var(--fog); }
	.views button[aria-pressed="true"] { background: var(--harbor); color: var(--on-harbor); }
	.views svg * { fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; }
	.missing { padding: 2rem clamp(1rem, 3vw, 2.5rem); }
	.missing p { margin-top: 0.75rem; color: var(--ink-2); }
	@media (max-width: 900px) {
		.stage { height: 72vh; }
	}
</style>
