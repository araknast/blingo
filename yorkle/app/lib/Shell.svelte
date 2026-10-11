<script lang="ts">
	import type { Snippet } from "svelte";
	import Dialog from "./Dialog.svelte";
	import { needs } from "./attention";
	import { route } from "./router.svelte";
	import { memorySeen } from "./seen";
	import type { RepoState } from "./types";
	import { api, logout, session } from "./session.svelte";
	import { toast, toastError } from "./toast.svelte";
	import { copy, repoName } from "./util";

	type Crumb = { label: string; href?: string; mono?: boolean };
	let {
		crumbs,
		actions,
		children,
		repo,
		data,
		full = false,
	}: { crumbs: Crumb[]; actions?: Snippet; children: Snippet; repo?: string; data?: RepoState | null; full?: boolean } = $props();

	// The tabs' counts. Only the Map's is an alert: what needs you, from every tab, is listed there.
	const counts = $derived.by(() => {
		if (!data || !repo) return {};
		const need = needs(data, memorySeen(repo));
		return {
			map: need.length,
			tasks: data.tasks.filter((t) => t.status !== "completed").length,
			agents: data.agents.filter((a) => a.status === "running").length,
			deploy: data.deploys.filter((d) => d.status === "running").length,
			memory: need.some((n) => n.key === "n:memory") ? data.memory.filter((m) => m.created > memorySeen(repo)).length : 0,
		};
	});

	// The repository's views, as tabs in the sidebar. The map also covers its bubbles and loose forks.
	const tabs = $derived.by(() => {
		if (!repo) return [];
		const base = `/repos/${repo}`;
		const p = route.path.replace(/\/+$/, "");
		const under = (s: string) => p === `${base}/${s}` || p.startsWith(`${base}/${s}/`);
		return [
			{ label: "Map", href: base, active: p === base || under("b"), count: counts.map, alert: true },
			{ label: "Tasks", href: `${base}/tasks`, active: under("tasks"), count: counts.tasks },
			{ label: "Agents", href: `${base}/agents`, active: under("agents") || under("forks"), count: counts.agents },
			{ label: "Deploy", href: `${base}/deploy`, active: under("deploy"), count: counts.deploy },
			{ label: "Skills", href: `${base}/skills`, active: under("skills") },
			{ label: "Memory", href: `${base}/memory`, active: under("memory"), count: counts.memory },
			{ label: "Settings", href: `${base}/settings`, active: under("settings") },
		];
	});

	let drawer = $state(false);
	let inviteOpen = $state(false);
	let invite = $state("");

	async function newInvite() {
		try {
			invite = (await api<{ code: string }>("POST", "/invites")).code;
			inviteOpen = true;
		} catch (e) {
			toastError(e);
		}
	}
	// Close the mobile drawer on navigation.
	$effect(() => {
		route.path;
		drawer = false;
	});
</script>

<div class="shell" class:full>
	<nav class="side" class:open={drawer} aria-label="Main">
		<a class="wordmark" href="/repos">yorkle</a>
		<ul>
			<li><a href="/repos" aria-current={route.path === "/repos" ? "page" : undefined}>Repositories</a></li>
			{#if repo}
				<li class="repo-nav">
					<span class="repo-name" title={repo}>{repoName(repo, session.me?.names)}</span>
					<ul aria-label="Repository">
						{#each tabs as t (t.label)}
							<li><a href={t.href} aria-current={t.active ? "page" : undefined}>{t.label}{#if t.count}<span class="n" class:alert={"alert" in t}>{t.count}<span class="visually-hidden">{"alert" in t ? " need you" : ""}</span></span>{/if}</a></li>
						{/each}
					</ul>
				</li>
			{/if}
		</ul>
		<div class="me">
			{#if session.me?.admin}
				<button class="side-button" onclick={newInvite}>Invite someone</button>
			{/if}
			<div class="who">
				<span class="avatar" aria-hidden="true">{session.me?.username.slice(0, 1).toUpperCase()}</span>
				<span>{session.me?.username}</span>
			</div>
			<button class="side-button" onclick={logout}>Log out</button>
		</div>
	</nav>
	{#if drawer}<button class="scrim" aria-label="Close menu" onclick={() => (drawer = false)}></button>{/if}

	<div class="main">
		<header class="top">
			<button class="quiet menu" aria-label="Open menu" aria-expanded={drawer} onclick={() => (drawer = true)}>
				<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4h14M2 9h14M2 14h14" stroke="currentColor" stroke-width="1.6" /></svg>
			</button>
			<ol class="crumbs">
				{#each crumbs as c, i}
					<li class:mono={c.mono}>
						{#if c.href && i < crumbs.length - 1}<a href={c.href}>{c.label}</a>{:else}<span aria-current="page">{c.label}</span>{/if}
					</li>
				{/each}
			</ol>
			{#if actions}<div class="actions">{@render actions()}</div>{/if}
		</header>
		<main>{@render children()}</main>
	</div>
</div>

<Dialog bind:open={inviteOpen} title="Invite someone">
	<p>Send this code to the person you're inviting. It works for one signup.</p>
	<div class="code-row">
		<code>{invite}</code>
		<button onclick={() => copy(invite).then(() => toast("Invite code copied"))}>Copy</button>
	</div>
</Dialog>

<style>
	.shell { display: grid; grid-template-columns: 232px 1fr; min-height: 100dvh; }
	.shell.full { height: 100dvh; }
	.side {
		position: sticky;
		top: 0;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--harbor);
		color: var(--on-harbor);
		padding: 1.1rem 0.75rem 1rem;
		z-index: 20;
	}
	.wordmark {
		font-weight: 700;
		font-size: 1.5rem;
		letter-spacing: -0.04em;
		color: #fff;
		text-decoration: none;
		padding: 0 0.6rem 1.25rem;
	}
	.side ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
	.side ul a {
		display: block;
		padding: 0.45rem 0.6rem;
		border-radius: var(--r-sm);
		text-decoration: none;
		font-size: 0.9375rem;
		color: var(--on-harbor);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.side ul a:hover { background: rgb(255 255 255 / 0.06); color: #fff; }
	.side ul a[aria-current="page"] { background: rgb(255 255 255 / 0.1); color: #fff; }
	.repo-nav { margin-top: 0.75rem; }
	.repo-name { display: block; padding: 0.3rem 0.6rem; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: rgb(255 255 255 / 0.55); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.repo-nav a { display: flex !important; justify-content: space-between; align-items: center; padding-left: 1rem !important; }
	.repo-nav .n { font-size: 0.75rem; padding: 0 0.4rem; border-radius: 999px; background: rgb(255 255 255 / 0.12); font-variant-numeric: tabular-nums; }
	.repo-nav .n.alert { background: var(--conflict); color: #fff; font-weight: 600; }
	.me { margin-top: auto; display: grid; gap: 0.4rem; }
	.who { display: flex; align-items: center; gap: 0.6rem; padding: 0.5rem 0.6rem; font-size: 0.9375rem; color: #fff; }
	.avatar {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.8125rem;
		font-weight: 700;
		background: linear-gradient(135deg, var(--teal), var(--lilac) 55%, var(--amber));
		color: var(--harbor);
	}
	.side-button {
		justify-content: flex-start;
		background: none;
		border: 0;
		color: var(--on-harbor);
		padding: 0.45rem 0.6rem;
	}
	.side-button:hover { background: rgb(255 255 255 / 0.06); color: #fff; }

	.main { min-width: 0; display: flex; flex-direction: column; }
	.full .main { height: 100dvh; }
	.top {
		display: flex;
		align-items: center;
		gap: 1rem;
		min-height: 3.5rem;
		padding: 0.5rem 1.5rem;
		border-bottom: 1px solid var(--line);
		background: var(--paper);
		position: sticky;
		top: 0;
		z-index: 10;
	}
	.menu { display: none; padding: 0.35rem 0.5rem; }
	.crumbs { display: flex; flex-wrap: wrap; align-items: center; list-style: none; margin: 0; padding: 0; min-width: 0; font-size: 0.9375rem; }
	.crumbs li + li::before { content: "/"; color: var(--ink-3); margin: 0 0.5rem; }
	.crumbs a { color: var(--ink-2); text-decoration: none; }
	.crumbs a:hover { color: var(--ink); text-decoration: underline; }
	.crumbs span { font-weight: 700; }
	.crumbs .mono { font-size: 0.875rem; }
	.actions { margin-left: auto; display: flex; gap: 0.5rem; }
	main { flex: 1; min-height: 0; }
	.code-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 1rem; }
	.code-row code { flex: 1; padding: 0.55rem 0.75rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 0.9375rem; }
	.scrim { display: none; }
	@media (max-width: 900px) {
		.shell.full, .full .main { height: auto; }
	}

	@media (max-width: 768px) {
		.shell { grid-template-columns: 1fr; }
		.side { position: fixed; left: 0; width: 260px; transform: translateX(-100%); transition: transform 180ms ease; }
		.side.open { transform: none; }
		.scrim { display: block; position: fixed; inset: 0; background: rgb(15 24 33 / 0.45); border: 0; border-radius: 0; z-index: 15; }
		.menu { display: inline-flex; }
		.top { padding: 0.5rem 1rem; gap: 0.5rem; }
		.crumbs { font-size: 0.875rem; flex-wrap: nowrap; overflow: hidden; }
		.crumbs li:not(:last-child) { display: none; }
		.crumbs li + li::before { content: none; }
		.crumbs span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
		.actions :global(button) { padding: 0.4rem 0.65rem; }
	}
</style>
