<script lang="ts">
	// A bubble's code: Source, Commits, Forks, and a ferge's Conflicts. On its own page (BubbleCode) and
	// in the Overview's drawer. `base` is where its links go: a path, or the drawer's URL with `&p=`.
	// `actions` puts page-level buttons (the Clone button) beside the title, on the page itself.
	import type { Snippet } from "svelte";
	import { route } from "./router.svelte";
	import type { RepoState } from "./types";
	import { fergeAgent } from "./attention";
	import { plural, short } from "./util";
	import Source from "../routes/bubble/Source.svelte";
	import Commits from "../routes/bubble/Commits.svelte";
	import CommitView from "../routes/bubble/CommitView.svelte";
	import Forks from "../routes/bubble/Forks.svelte";
	import Conflicts from "../routes/bubble/Conflicts.svelte";

	let {
		repo,
		bubble,
		rest,
		base,
		at,
		data,
		refresh,
		actions,
	}: { repo: string; bubble: string; rest: string; base: string; at?: string; data: RepoState | null; refresh: () => unknown; actions?: Snippet } = $props();

	const b = $derived(data?.bubbles.find((x) => x.id === bubble));
	// A fork not in a bubble yet (one waiting for review, say) can be browsed the same way.
	const loose = $derived(!!data?.loose.some((l) => l.fork === bubble));
	// An absorbed bubble's representative lives on as a member of the bubble that took it in.
	const absorbedInto = $derived(data && !b ? data.bubbles.find((x) => x.members.some((m) => m.name === bubble))?.id : undefined);
	const tab = $derived(rest.startsWith("commits") ? "commits" : rest === "forks" ? "forks" : rest === "conflicts" ? "conflicts" : "source");
	const srcPath = $derived(rest.startsWith("src/") ? rest.slice(4) : "");
	const commitHash = $derived(rest.match(/^commits\/([0-9a-f]{40})$/)?.[1]);
</script>

{#if !data}
	<p class="muted">Loading…</p>
{:else if !b && !loose}
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
				{#if actions}<div class="head-actions">{@render actions()}</div>{/if}
			</header>

			<nav class="tabs" aria-label="Bubble">
				<a href="{base}/src/" aria-current={tab === "source" ? "page" : undefined}>Source</a>
				<a href="{base}/commits" aria-current={tab === "commits" ? "page" : undefined}>Commits</a>
				<a href="{base}/forks" aria-current={tab === "forks" ? "page" : undefined}>Forks {#if b}<span class="n">{b.members.length}</span>{/if}</a>
				{#if b?.ferge}<a href="{base}/conflicts" aria-current={tab === "conflicts" ? "page" : undefined}>Conflicts</a>{/if}
			</nav>

			{#if tab === "source"}
				{#key srcPath + route.search}<Source {repo} {bubble} path={srcPath} {base} {at} />{/key}
			{:else if commitHash}
				{#key commitHash}<CommitView {repo} {bubble} hash={commitHash} {base} />{/key}
			{:else if tab === "commits"}
				<Commits {repo} {bubble} {base} />
			{:else if tab === "conflicts"}
				{#if b}<Conflicts {repo} {bubble} locked={b.locked} agent={data ? fergeAgent(data, bubble) : undefined} onchange={refresh} />{/if}
			{:else}
				<Forks {repo} members={b?.members ?? []} />
			{/if}
		</div>
{/if}

<style>
	.page { min-width: 0; }
	.gone p { margin-top: 0.75rem; color: var(--ink-2); }
	.head { display: flex; gap: 0.9rem; align-items: center; margin-bottom: 1.25rem; }
	.head-actions { margin-left: auto; }
	.film { flex: none; }
	.id { font-size: 1.375rem; font-weight: 400; letter-spacing: -0.02em; }
	.meta { font-size: 0.875rem; display: flex; gap: 0.5rem; align-items: center; margin-top: 0.15rem; }
	.tag { font-size: 0.75rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
</style>
