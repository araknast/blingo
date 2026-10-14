<script lang="ts">
	// A drawer on the map's left edge: the repo's tasks as a tree of what waits on what, all of them unless
	// a chip hides completed, in-progress or cancelled ones. Its open state is remembered per browser.
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
	const KINDS: { id: Kind; label: string }[] = [
		{ id: "completed", label: "Completed" },
		{ id: "in-progress", label: "In progress" },
		{ id: "cancelled", label: "Cancelled" },
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
			<a href={allHref}>All tasks</a>
			<div class="chips" role="group" aria-label="Show">
				{#each KINDS as k (k.id)}
					<button aria-pressed={shown[k.id]} onclick={() => (shown[k.id] = !shown[k.id])}>{k.label}</button>
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
			<a href={href(n.task.id)} aria-current={n.task.id === current ? "page" : undefined}>
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
	header { padding: 0.75rem 1rem; border-bottom: 1px solid var(--line-2); background: var(--paper); font-size: 0.875rem; font-weight: 600; }
	.chips { margin-top: 0.5rem; font-weight: 500; }
	header a { color: var(--ink); text-decoration: none; }
	header a:hover { text-decoration: underline; }
	.muted { padding: 1rem; }
	ul { list-style: none; margin: 0; padding: 0.4rem 0; }
	ul ul { padding: 0 0 0 1rem; margin-left: 0.9rem; border-left: 1px solid var(--line); }
	li a { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0.75rem; color: var(--ink); text-decoration: none; font-size: 0.875rem; border-radius: var(--r-sm); }
	ul ul li a { padding-left: 0.4rem; }
	li a:hover { background: var(--paper); }
	li a[aria-current="page"] { background: var(--raised); font-weight: 600; }
	li a:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.also { flex: none; font-size: 0.75rem; color: var(--ink-3); }
</style>
