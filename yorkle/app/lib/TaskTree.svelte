<script lang="ts">
	// A drawer on the map's left edge: the repo's tasks as a tree of what waits on what, all of them unless
	// a chip hides completed, in-progress or cancelled ones. Its open state is remembered per browser.
	import Mark from "./Mark.svelte";
	import TaskIcon from "./TaskIcon.svelte";
	import { taskTree, type TaskNode } from "./taskTree";
	import type { RepoState, Task } from "./types";

	let { data, href, allHref, current }: { data: RepoState | null; href: (id: string) => string; allHref: string; current?: string } = $props();

	const KEY = "yorkle.taskTree";
	let open = $state((() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })());
	function toggle() {
		open = !open;
		try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
	}
	// Cancelled: a notagent a person closed (its task reads failed). Rejected tasks are deleted.
	type Kind = "completed" | "in-progress" | "cancelled";
	const KINDS: { id: Kind; label: string; glyph: string }[] = [
		{ id: "completed", label: "Completed", glyph: "merged" },
		{ id: "in-progress", label: "In progress", glyph: "running" },
		{ id: "cancelled", label: "Cancelled", glyph: "failed" },
	];
	let shown = $state<Record<Kind, boolean>>({ completed: true, "in-progress": true, cancelled: true });
	const kindOf = (t: Task): Kind | null => (t.fork && data?.closed.includes(t.fork) ? "cancelled" : t.status === "completed" || t.status === "in-progress" ? t.status : null);
	const tasks = $derived(data?.tasks.filter((t) => { const k = kindOf(t); return !k || shown[k]; }) ?? []);
	const tree = $derived(taskTree(tasks));
</script>

<div class="tree-drawer" class:open>
	<button class="handle" onclick={toggle} aria-expanded={open} aria-controls="task-tree">
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>
		Tasks <span class="n">{tasks.length}</span>
	</button>
	<nav id="task-tree" class="panel" aria-label="Task tree" inert={!open}>
		<header>
			<div class="top">
				<h2>Tasks</h2>
				<a href={allHref}>All tasks <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg></a>
			</div>
			<div class="chips" role="group" aria-label="Show">
				{#each KINDS as k (k.id)}
					<button aria-pressed={shown[k.id]} onclick={() => (shown[k.id] = !shown[k.id])}><Mark status={k.glyph} />{k.label}</button>
				{/each}
			</div>
		</header>
		{#if !data}
			<p class="muted">Loading…</p>
		{:else if !tree.length}
			<p class="muted">{data.tasks.length ? "Every task is hidden." : "No tasks yet."}</p>
		{:else}
			<ul>{@render nodes(tree)}</ul>
		{/if}
	</nav>
</div>

{#snippet nodes(ns: TaskNode[])}
	{#each ns as n (n.task.id)}
		<li>
			<a href={href(n.task.id)} title={n.task.title} aria-current={n.task.id === current ? "page" : undefined} class:done={!!kindOf(n.task) && kindOf(n.task) !== "in-progress"}>
				<TaskIcon status={n.task.status} />
				<span class="t">{n.task.title}</span>
				{#if n.also}<span class="also" title="Also waits for {n.also} more">+{n.also}</span>{/if}
			</a>
			{#if n.children.length}<ul>{@render nodes(n.children)}</ul>{/if}
		</li>
	{/each}
{/snippet}

<style>
	.tree-drawer {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: min(20rem, 85%);
		z-index: 7;
		translate: -100% 0;
		transition: translate 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.tree-drawer.open { translate: 0 0; }
	@media (prefers-reduced-motion: reduce) { .tree-drawer { transition: none; } }
	.handle {
		position: absolute;
		left: 100%;
		top: 50%;
		translate: 0 -50%;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		writing-mode: vertical-rl;
		padding: 0.75rem 0.4rem;
		border: 1px solid var(--line);
		border-left: 0;
		border-radius: 0 var(--r-md) var(--r-md) 0;
		background: var(--raised);
		box-shadow: 4px 0 12px rgb(15 24 33 / 0.08);
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--ink-2);
	}
	.handle:hover { color: var(--ink); }
	.handle svg { rotate: 0deg; transition: rotate 150ms ease-out; }
	.open .handle svg { rotate: 180deg; }
	.handle path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
	.n { font-weight: 500; color: var(--ink-3); font-variant-numeric: tabular-nums; }
	.panel {
		height: 100%;
		overflow-y: auto;
		background: var(--fog);
		border-right: 1px solid var(--line);
		box-shadow: 12px 0 32px rgb(15 24 33 / 0.12);
		visibility: hidden;
		transition: visibility 0s 200ms;
	}
	.open .panel { visibility: visible; transition: none; }
	header { position: sticky; top: 0; z-index: 1; padding: 0.75rem 0.75rem 0.7rem 1rem; border-bottom: 1px solid var(--line-2); background: var(--paper); }
	.top { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.6rem; }
	h2 { font-size: 0.9375rem; }
	.top a { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.8125rem; color: var(--ink-2); text-decoration: none; }
	.top a:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
	.top a path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
	/* Toggles, all on by default: on reads as a plain chip, off fades to a dashed outline. */
	.chips { gap: 0.3rem; }
	.chips button { padding: 0.15rem 0.55rem 0.15rem 0.4rem; font-size: 0.75rem; gap: 0.3rem; }
	.chips button[aria-pressed="true"] { background: var(--raised); border-color: var(--line); color: var(--ink); }
	.chips button[aria-pressed="true"]:hover { border-color: var(--ink-3); }
	.chips button[aria-pressed="false"] { background: none; border-style: dashed; color: var(--ink-3); }
	.chips button[aria-pressed="false"] :global(.mark) { opacity: 0.4; }
	.chips :global(.mark) { width: 11px; height: 11px; }
	.muted { padding: 1rem; font-size: 0.875rem; }

	/* The tree: a connector drops from each parent's mark and ticks into each child's. */
	ul { --pad: 0.5rem; --step: 0.875rem; --mid: calc(0.35rem + 0.6rem); list-style: none; margin: 0; padding: 0.4rem 0.5rem 0.75rem; }
	ul ul { padding: 0 0 0 var(--step); margin-left: calc(var(--pad) + 6.5px); }
	ul ul > li { position: relative; }
	ul ul > li::before, ul ul > li::after { content: ""; position: absolute; left: calc(-1 * var(--step)); border-color: var(--line); border-style: solid; border-width: 0; }
	ul ul > li::before { top: 0; bottom: 0; border-left-width: 1px; }
	ul ul > li::after { top: var(--mid); width: calc(var(--step) + var(--pad) - 4px); border-top-width: 1px; }
	ul ul > li:last-child::before { bottom: auto; height: var(--mid); width: calc(var(--step) + var(--pad) - 4px); border-bottom-width: 1px; border-bottom-left-radius: 6px; }
	ul ul > li:last-child::after { display: none; }
	li a {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.35rem var(--pad);
		color: var(--ink);
		text-decoration: none;
		font-size: 0.875rem;
		line-height: 1.35;
		border-radius: var(--r-sm);
	}
	/* The mark sits on the title's first line. */
	li a > :global(.icon) { height: 1.2rem; align-items: center; }
	li a.done { color: var(--ink-2); }
	li a:hover { background: var(--paper); color: var(--ink); }
	li a[aria-current="page"] { background: var(--raised); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgb(15 24 33 / 0.08), 0 0 0 1px var(--line-2); }
	li a:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.t { flex: 1; min-width: 0; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
	.also { flex: none; margin-top: 0.1rem; padding: 0 0.35rem; border: 1px solid var(--line); border-radius: 999px; font-size: 0.6875rem; line-height: 1rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }
</style>
