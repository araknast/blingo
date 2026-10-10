<script lang="ts">
	import BubbleMap from "../lib/BubbleMap.svelte";
	import ContextMenu, { type MenuItem } from "../lib/ContextMenu.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import SkillPicker from "../lib/SkillPicker.svelte";
	import ModelField from "../lib/ModelField.svelte";
	import ForkCommands from "../lib/ForkCommands.svelte";
	import Shell from "../lib/Shell.svelte";
	import SuperagentDialog from "../lib/SuperagentDialog.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { navigate } from "../lib/router.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import { plural, repoName, short } from "../lib/util";

	let { repo }: { repo: string } = $props();

	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const repoData = repoState(repo, 2500);
	const data = $derived(repoData.data);
	const refresh = repoData.refresh;
	const bubbleHref = (id: string) => `/repos/${repo}/b/${id}`;
	const bubbleName = (id: string) => data?.bubbles.find((b) => b.id === id)?.name || short(id);

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
	let agentModel = $state("");
	let agentSkills = $state<string[] | undefined>(undefined);
	let busy = $state(false);
	async function startAgent(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api<{ awaitingApproval?: boolean }>("POST", "/agents", { repo, title: agentTitle, prompt, bubble: agentBase || undefined, model: agentModel.trim() || undefined, skills: agentSkills });
			agentOpen = false;
			agentTitle = prompt = "";
			toast(r.awaitingApproval ? "Task filed. It starts once it's approved on the Tasks tab." : "Agent started. Its task is on the Tasks tab.");
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
			if (r.awaitingApproval) {
				pushOpen = false;
				toast("Task filed. Take it from the Tasks tab once it's approved.");
			} else pushed = r;
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
		try {
			await api("POST", `/repos/${repo}/${lock ? "lock" : "unlock"}`, { bubble: id });
			toast(lock ? `Locked ${bubbleName(id)}` : `Unlocked ${bubbleName(id)}`);
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
			await refresh();
			toast(`Ferged. ${bubbleName(r.locked)} holds ${plural(r.files.length, "conflicting file")}.`);
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names) }]}
	{repo}
	openTasks={data?.tasks.filter((t) => t.status !== "completed").length}
	activeAgents={data?.agents.filter((a) => a.status === "running").length}
	full
>
	{#if repoData.missing}
		<div class="missing">
			<h1>This repository isn't available</h1>
			<p>It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		</div>
	{:else}
		<section class="stage" aria-label="Bubble map">
			<BubbleMap
				{data}
				hrefFor={bubbleHref}
				agentHref={(fork) => `/repos/${repo}/agents/${fork}`}
				looseHref={(fork) => `/repos/${repo}/forks/${fork}`}
				onconflict={askFerge}
				oncontext={(at) => (menu = at)}
			/>
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
		<div class="row">
			<button class="primary" onclick={ferge} disabled={busy}>Ferge bubbles</button>
			<button onclick={() => (fergeOpen = false)}>Cancel</button>
		</div>
	{/if}
</Dialog>


<style>
	.stage { height: 100%; min-height: 0; position: relative; }
	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	.from { font-size: 0.875rem; color: var(--ink-2); }
	.from span { color: var(--ink); }
	.row { display: flex; gap: 0.5rem; }
	.missing { padding: 2rem clamp(1rem, 3vw, 2.5rem); }
	.missing p { margin-top: 0.75rem; color: var(--ink-2); }
	@media (max-width: 900px) {
		.stage { height: 72vh; }
	}
</style>
