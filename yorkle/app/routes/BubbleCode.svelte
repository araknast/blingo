<script lang="ts">
	import { onDestroy } from "svelte";
	import Shell from "../lib/Shell.svelte";
	import { route } from "../lib/router.svelte";
	import { ApiError, api, session } from "../lib/session.svelte";
	import type { RepoState } from "../lib/types";
	import { plural, poll, repoName, short } from "../lib/util";
	import Source from "./bubble/Source.svelte";
	import Commits from "./bubble/Commits.svelte";
	import CommitView from "./bubble/CommitView.svelte";
	import Forks from "./bubble/Forks.svelte";
	import Conflicts from "./bubble/Conflicts.svelte";

	let { repo, bubble, rest }: { repo: string; bubble: string; rest: string } = $props();

	let data = $state<RepoState | null>(null);
	let missingRepo = $state(false);
	async function refresh() {
		try {
			data = await api<RepoState>("GET", `/repos/${repo}`);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) missingRepo = true;
		}
	}
	const stop = poll(refresh, 5000);
	onDestroy(stop);

	const b = $derived(data?.bubbles.find((x) => x.id === bubble));
	// An absorbed bubble's representative lives on as a member of the bubble that took it in.
	// A fork not in a bubble yet (one waiting for review, say) can be browsed the same way.
	const loose = $derived(!!data?.loose.some((l) => l.fork === bubble));
	const absorbedInto = $derived(data && !b ? data.bubbles.find((x) => x.members.some((m) => m.name === bubble))?.id : undefined);

	const base = $derived(`/repos/${repo}/b/${bubble}`);
	const tab = $derived(rest.startsWith("commits") ? "commits" : rest === "forks" ? "forks" : rest === "conflicts" ? "conflicts" : "source");
	const srcPath = $derived(rest.startsWith("src/") ? rest.slice(4) : "");
	const commitHash = $derived(rest.match(/^commits\/([0-9a-f]{40})$/)?.[1]);
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		{ label: b?.name || `${loose ? "Fork" : "Bubble"} ${short(bubble)}`, href: base },
	]}
	{repo}
	{data}
>
	{#if missingRepo}
		<div class="page"><h1>This repository isn't available</h1><p class="muted">It doesn't exist, or it belongs to someone else.</p></div>
	{:else if data && !b && !loose}
		<div class="page gone">
			<h1>This bubble has merged into another one</h1>
			{#if absorbedInto}
				<p>Its code now lives in <a href="/repos/{repo}/b/{absorbedInto}">{data.bubbles.find((x) => x.id === absorbedInto)?.name || short(absorbedInto)}</a>.</p>
			{:else}
				<p>Its code now lives in another bubble. <a href="/repos/{repo}">Open the bubble map</a> to find it.</p>
			{/if}
		</div>
	{:else}
		<div class="page">
			<header class="head">
				<svg class="film" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
					<defs><linearGradient id="hdr-film" gradientTransform="rotate(30 .5 .5)"><stop offset="0" stop-color="var(--teal)" /><stop offset=".5" stop-color="var(--lilac)" /><stop offset="1" stop-color="var(--amber)" /></linearGradient></defs>
					<circle cx="18" cy="18" r="15" fill="none" stroke="url(#hdr-film)" stroke-width="3" />
				</svg>
				<div>
					<h1>{#if b?.name}{b.name}{:else}{loose ? "Fork" : "Bubble"} <span class="mono id">{short(bubble)}</span>{/if}</h1>
					<p class="muted meta">
						{#if b}
							{plural(b.members.length, "fork")}
							{#if b.ferge}<span class="tag">Ferge</span>{/if}
							{#if b.locked}<span class="tag">Locked</span>{/if}
							{#if !b.visible}<span class="tag">Merging</span>{/if}
						{:else}&nbsp;{/if}
					</p>
				</div>
			</header>

			<nav class="tabs" aria-label="Bubble">
				<a href="{base}/src/" aria-current={tab === "source" ? "page" : undefined}>Source</a>
				<a href="{base}/commits" aria-current={tab === "commits" ? "page" : undefined}>Commits</a>
				<a href="{base}/forks" aria-current={tab === "forks" ? "page" : undefined}>Forks {#if b}<span class="n">{b.members.length}</span>{/if}</a>
				{#if b?.ferge}<a href="{base}/conflicts" aria-current={tab === "conflicts" ? "page" : undefined}>Conflicts</a>{/if}
			</nav>

			{#if tab === "source"}
				{#key srcPath + route.search}<Source {repo} {bubble} path={srcPath} {base} />{/key}
			{:else if commitHash}
				{#key commitHash}<CommitView {repo} {bubble} hash={commitHash} {base} />{/key}
			{:else if tab === "commits"}
				<Commits {repo} {bubble} {base} />
			{:else if tab === "conflicts"}
				{#if b}<Conflicts {repo} {bubble} locked={b.locked} onchange={refresh} />{/if}
			{:else}
				<Forks {repo} members={b?.members ?? []} />
			{/if}
		</div>
	{/if}
</Shell>

<style>
	.page { padding: 1.75rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 80rem; }
	.gone p { margin-top: 0.75rem; color: var(--ink-2); }
	.head { display: flex; gap: 0.9rem; align-items: center; margin-bottom: 1.25rem; }
	.film { flex: none; }
	.id { font-size: 1.375rem; font-weight: 400; letter-spacing: -0.02em; }
	.meta { font-size: 0.875rem; display: flex; gap: 0.5rem; align-items: center; margin-top: 0.15rem; }
	.tag { font-size: 0.75rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
</style>
