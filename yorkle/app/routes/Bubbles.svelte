<script lang="ts">
	// The repository's bubbles as a list, to manage them: what needs you first (a conflict to ferge, a ferge
	// to fix and unlock, changes that didn't apply), then the rest by name. The Overview shows the same
	// bubbles as a map.
	import { fergeAgent, needs } from "../lib/attention";
	import { bubbleName, ferge, fergeFiles, setLock } from "../lib/bubbleActions";
	import { ask } from "../lib/confirm.svelte";
	import { fileCount } from "../lib/layout";
	import Mark from "../lib/Mark.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { navigate } from "../lib/router.svelte";
	import { session } from "../lib/session.svelte";
	import type { Bubble } from "../lib/types";
	import { plural, repoName, short } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 4000);
	const data = $derived(rd.data);

	// What needs you, per bubble.
	const why = $derived.by(() => {
		const by = new Map<string, string[]>();
		const add = (id: string, w: string) => by.set(id, [...(by.get(id) ?? []), w]);
		for (const n of data ? needs(data) : []) {
			if (n.kind === "conflict") (add(n.a, `Conflicts with ${bubbleName(data, n.b)}`), add(n.b, `Conflicts with ${bubbleName(data, n.a)}`));
			else if (n.kind === "member") add(n.bubble, `Changes from fork ${short(n.fork)} didn't apply`);
			else if (n.kind === "ferge") add(n.bubble, n.why);
		}
		return by;
	});
	const partners = (id: string) => (data?.conflicts ?? []).flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : []));

	let filter = $state<"all" | "needs">("all");
	let query = $state("");
	const list = $derived(
		[...(data?.bubbles ?? [])]
			.filter((b) => filter === "all" || why.has(b.id))
			.filter((b) => !query.trim() || (b.name || b.id).toLowerCase().includes(query.trim().toLowerCase()))
			.sort((a, b) => Number(why.has(b.id)) - Number(why.has(a.id)) || (a.name || a.id).localeCompare(b.name || b.id)),
	);
	const needy = $derived(data?.bubbles.filter((b) => why.has(b.id)).length ?? 0);

	let busy = $state(false);
	async function lock(b: Bubble, on: boolean) {
		busy = true;
		if (await setLock(repo, data, b.id, on)) await rd.refresh();
		busy = false;
	}
	async function fergeWith(a: string, b: string) {
		const files = fergeFiles(data, a, b);
		const ok = await ask({
			title: `Ferge ${bubbleName(data, a)} and ${bubbleName(data, b)}?`,
			body: `They merge without the files they conflict on${files.length ? ` (${plural(files.length, "file")}: ${files.slice(0, 4).join(", ")}${files.length > 4 ? "…" : ""})` : ""}. A new locked bubble holds those files with conflict markers: fix them in a fork of it, then unlock it.`,
			confirm: "Ferge bubbles",
		});
		if (!ok) return;
		busy = true;
		const locked = await ferge(repo, data, a, b);
		busy = false;
		if (locked) await rd.refresh();
	}
	const tags = (b: Bubble) => [!b.visible && "Merging", b.ferge && "Ferge", b.locked && "Locked"].filter(Boolean) as string[];
	const failed = (b: Bubble) => b.members.filter((m) => m.status === "failed").length;
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Bubbles" }]}
	{repo}
	{data}
>
	<div class="page">
		<h1>Bubbles</h1>
		<p class="lede">Each bubble holds forks that changed different files, and merges them as they come. The Overview shows them as a map; here you can manage them one by one.</p>
		{#if rd.missing}
			<p class="muted">This repository isn't available. <a href="/repos">Go to your repositories</a>.</p>
		{:else if !data}
			<p class="muted">Loading…</p>
		{:else if !data.bubbles.length}
			<div class="empty">
				<p>No bubbles yet. The first fork that lands starts one.</p>
				<a class="button primary" href="/repos/{repo}">Go to the Overview</a>
			</div>
		{:else}
			<div class="toolbar">
				<div class="chips" role="group" aria-label="Show">
					<button aria-pressed={filter === "all"} onclick={() => (filter = "all")}>All <span class="n">{data.bubbles.length}</span></button>
					<button aria-pressed={filter === "needs"} onclick={() => (filter = "needs")}>Needs you <span class="n">{needy}</span></button>
				</div>
				<input type="search" bind:value={query} placeholder="Filter by name" aria-label="Filter bubbles by name" />
			</div>
			{#if !list.length}
				<p class="muted">{filter === "needs" ? "No bubble needs you." : "No bubble matches."}</p>
			{:else}
				<ul class="bubbles">
					{#each list as b (b.id)}
						{@const w = why.get(b.id) ?? []}
						<li class:needs={w.length}>
							<div class="main">
								<p class="name">
									<a href="/repos/{repo}/b/{b.id}">{b.name || short(b.id)}</a>
									{#each tags(b) as s}<span class="badge">{s}</span>{/each}
								</p>
								<p class="meta">
									{plural(b.members.length, "fork")} · {plural(fileCount(b), "file")}
									{#if failed(b)}· <Mark status="failed" /> {failed(b)} didn't apply{/if}
								</p>
								{#each w as x}<p class="why"><Mark status={x.startsWith("Conflicts") ? "conflict" : "failed"} /> {x}</p>{/each}
							</div>
							<div class="actions">
								{#each partners(b.id) as p (p)}
									<button class="primary" disabled={busy} onclick={() => fergeWith(b.id, p)}>Ferge with {bubbleName(data, p)}…</button>
								{/each}
								{#if b.ferge && b.locked && !fergeAgent(data, b.id)}<a class="button" href="/repos/{repo}/b/{b.id}/conflicts">Fix conflicts</a>{/if}
								<button disabled={busy || !b.visible} onclick={() => lock(b, !b.locked)}>{b.locked ? "Unlock" : "Lock"}</button>
								{#if data.settings.deploys.length}
									<button class="quiet" disabled={!b.visible || b.locked} onclick={() => navigate(`/repos/${repo}/deploy?bubble=${encodeURIComponent(b.id)}`)}>Deploy…</button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 64rem; }
	.lede { margin: 0.4rem 0 1.25rem; color: var(--ink-2); max-width: 65ch; }
	.empty { display: grid; justify-items: start; gap: 0.75rem; padding: 1.25rem; border: 1px dashed var(--line); border-radius: var(--r-md); }
	.toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin-bottom: 0.75rem; }
	.toolbar input { width: 14rem; max-width: 100%; }
	.bubbles { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	.bubbles li { display: flex; flex-wrap: wrap; gap: 0.6rem 1.25rem; align-items: center; padding: 0.8rem 1rem; }
	.bubbles li + li { border-top: 1px solid var(--line-2); }
	.bubbles li.needs { background: color-mix(in srgb, var(--conflict) 4%, var(--raised)); }
	.main { flex: 1 1 18rem; min-width: 0; }
	.name { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
	.name a { font-weight: 600; color: var(--ink); text-decoration: none; overflow-wrap: anywhere; }
	.name a:hover { text-decoration: underline; }
	.meta { font-size: 0.8125rem; color: var(--ink-3); margin-top: 0.15rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; }
	.why { font-size: 0.875rem; color: var(--conflict); margin-top: 0.3rem; display: flex; align-items: center; gap: 0.4rem; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.4rem; justify-content: flex-end; }
	.actions button, .actions .button { padding: 0.3rem 0.7rem; font-size: 0.875rem; }
</style>
