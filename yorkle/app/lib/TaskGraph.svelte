<script lang="ts">
	// A drawer on the map's left edge: the repo's tasks as a graph of what waits on what, every dep an edge,
	// all of them unless a chip hides ready-to-take, in-progress, completed or cancelled ones. Drag to pan,
	// wheel or buttons to zoom; hovering or opening a task lights up everything it waits on and everything
	// that waits on it. Its open state is remembered per browser.
	import Mark from "./Mark.svelte";
	import TaskIcon from "./TaskIcon.svelte";
	import { GAP_Y, lineage, NODE_H, NODE_W, taskGraph } from "./taskGraph";
	import type { RepoState, Task } from "./types";

	let { data, href, allHref, current }: { data: RepoState | null; href: (id: string) => string; allHref: string; current?: string } = $props();

	const KEY = "yorkle.taskTree";
	let open = $state((() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })());
	function toggle() {
		open = !open;
		try { localStorage.setItem(KEY, open ? "1" : "0"); } catch {}
	}
	// Cancelled: a notagent a person closed (its task reads failed). Rejected tasks are deleted.
	// Ready to take: an open notagent whose deps have landed, as the task list groups it.
	type Kind = "completed" | "in-progress" | "cancelled" | "ready";
	const KINDS: { id: Kind; label: string; glyph: string }[] = [
		{ id: "ready", label: "Ready to take", glyph: "pending" },
		{ id: "in-progress", label: "In progress", glyph: "running" },
		{ id: "completed", label: "Completed", glyph: "merged" },
		{ id: "cancelled", label: "Cancelled", glyph: "failed" },
	];
	let shown = $state<Record<Kind, boolean>>({ completed: true, "in-progress": true, cancelled: true, ready: true });
	const kindOf = (t: Task): Kind | null =>
		t.fork && data?.closed.includes(t.fork) ? "cancelled"
		: t.status === "completed" || t.status === "in-progress" ? t.status
		: t.status === "open" && t.ready && t.kind === "notagent" ? "ready"
		: null;
	const tasks = $derived(data?.tasks.filter((t) => { const k = kindOf(t); return !k || shown[k]; }) ?? []);
	const graph = $derived(taskGraph(tasks));
	const at = $derived(new Map(graph.nodes.map((n) => [n.task.id, n])));

	let hovered = $state<string | null>(null);
	const focus = $derived(hovered ?? (current && at.has(current) ? current : null));
	const lit = $derived(focus ? lineage(graph.edges, focus) : null);

	// ---- Pan and zoom ----
	let view: HTMLDivElement;
	let w = $state(0), h = $state(0);
	let tx = $state(0), ty = $state(0), k = $state(1);
	let userMoved = false;
	function fit() {
		if (!graph.nodes.length || !w || !h) return;
		const xs = graph.nodes.map((n) => n.x), bottom = Math.max(...graph.nodes.map((n) => n.y)) + NODE_H;
		const left = Math.min(...xs) - NODE_W / 2, right = Math.max(...xs) + NODE_W / 2;
		// Never so small the titles can't be read; then centre on the open task, if it's shown.
		k = Math.max(0.5, Math.min(1, (w - 32) / (right - left), (h - 32) / bottom));
		const cx = (right - left) * k > w - 32 && current && at.has(current) ? at.get(current)!.x : (left + right) / 2;
		tx = w / 2 - cx * k;
		ty = Math.max(16, h / 2 - (bottom / 2) * k);
	}
	// Refit when the graph's shape or the drawer's size changes, unless the user has moved it.
	$effect(() => {
		graph;
		w;
		h;
		if (!userMoved) fit();
	});
	function zoomBy(f: number, sx = w / 2, sy = h / 2) {
		const nk = Math.max(0.25, Math.min(2, k * f));
		tx = sx - ((sx - tx) / k) * nk;
		ty = sy - ((sy - ty) / k) * nk;
		k = nk;
		userMoved = true;
	}
	function refit() {
		userMoved = false;
		fit();
	}
	$effect(() => {
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r = view.getBoundingClientRect();
			zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
		};
		view.addEventListener("wheel", onWheel, { passive: false });
		return () => view.removeEventListener("wheel", onWheel);
	});

	// A drag that starts on a card pans too; it only opens the card if the pointer barely moved.
	let drag: { x: number; y: number; moved: boolean; pointer: number } | null = null;
	let suppressClick = false;
	let grabbing = $state(false);
	function down(e: PointerEvent) {
		if (e.button !== 0) return;
		drag = { x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId };
		suppressClick = false;
	}
	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointer) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 5) return;
		if (!drag.moved) {
			drag.moved = grabbing = true;
			view.setPointerCapture(e.pointerId);
		}
		tx += dx;
		ty += dy;
		drag.x = e.clientX;
		drag.y = e.clientY;
		userMoved = true;
	}
	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointer) return;
		suppressClick = drag.moved;
		drag = null;
		grabbing = false;
	}

	// Arrows pan, + and − zoom, F or 0 fits.
	function keys(e: KeyboardEvent) {
		if (e.altKey || e.ctrlKey || e.metaKey || e.target !== view) return;
		const step = e.shiftKey ? 240 : 80;
		const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
		if (pan) {
			e.preventDefault();
			tx += pan[0];
			ty += pan[1];
			userMoved = true;
		} else if (e.key === "+" || e.key === "=") zoomBy(1.25);
		else if (e.key === "-" || e.key === "_") zoomBy(0.8);
		else if (e.key === "f" || e.key === "F" || e.key === "0") refit();
	}

	// From the bottom of a dep's card to the top of its dependent's.
	function path(from: string, to: string) {
		const a = at.get(from)!, b = at.get(to)!;
		const y1 = a.y + NODE_H, y2 = b.y - 3, c = Math.max(GAP_Y / 2, (y2 - y1) / 2);
		return `M${a.x} ${y1}C${a.x} ${y1 + c} ${b.x} ${y2 - c} ${b.x} ${y2}`;
	}
</script>

<div class="tree-drawer" class:open>
	<button class="handle" onclick={toggle} aria-expanded={open} aria-controls="task-graph">
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5L8 6l-3.5 3.5" /></svg>
		Tasks <span class="n">{tasks.length}</span>
	</button>
	<nav id="task-graph" class="panel" aria-label="Task graph" inert={!open}>
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
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (the graph takes keys: arrows pan, + and − zoom, F fits) -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="view"
			class:grabbing
			bind:this={view}
			bind:clientWidth={w}
			bind:clientHeight={h}
			tabindex="0"
			role="group"
			aria-label="Task graph. Drag or arrow keys pan, wheel or plus and minus zoom, F fits."
			onpointerdown={down}
			onpointermove={move}
			onpointerup={up}
			onpointercancel={up}
			onkeydown={keys}
			onclickcapture={(e) => suppressClick && (e.preventDefault(), e.stopPropagation(), (suppressClick = false))}
		>
			{#if !data}
				<p class="muted">Loading…</p>
			{:else if !graph.nodes.length}
				<p class="muted">{data.tasks.length ? "Every task is hidden." : "No tasks yet."}</p>
			{:else}
				<div class="world" style:transform="translate({tx}px, {ty}px) scale({k})">
					<svg class="edges" aria-hidden="true">
						<defs>
							<marker id="task-arrow" viewBox="0 0 8 8" refX="4" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1.5L4 5l3-3.5" /></marker>
						</defs>
						{#each graph.edges as e (e.from + ">" + e.to)}
							<path d={path(e.from, e.to)} marker-end="url(#task-arrow)" class:on={lit?.has(e.from) && lit.has(e.to)} class:dim={lit && !(lit.has(e.from) && lit.has(e.to))} />
						{/each}
					</svg>
					{#each graph.nodes as n (n.task.id)}
						{@const kind = kindOf(n.task)}
						<a
							href={href(n.task.id)}
							title={n.task.title}
							draggable="false"
							style:left="{n.x - NODE_W / 2}px"
							style:top="{n.y}px"
							style:width="{NODE_W}px"
							style:height="{NODE_H}px"
							aria-current={n.task.id === current ? "page" : undefined}
							class:done={kind === "completed" || kind === "cancelled"}
							class:dim={lit && !lit.has(n.task.id)}
							onpointerenter={() => !grabbing && (hovered = n.task.id)}
							onpointerleave={() => hovered === n.task.id && (hovered = null)}
							onfocus={() => (hovered = n.task.id)}
							onblur={() => hovered === n.task.id && (hovered = null)}
						>
							<TaskIcon status={n.task.status} />
							<span class="body">
								<span class="t">{n.task.title}</span>
								{#if kind === "ready"}<span class="badge">Ready to take</span>{/if}
							</span>
							{#if n.hidden}<span class="also" title="Also waits for {n.hidden} hidden {n.hidden === 1 ? 'task' : 'tasks'}">+{n.hidden}</span>{/if}
						</a>
					{/each}
				</div>
				<div class="zoom" role="group" aria-label="Zoom">
					<button aria-label="Zoom out" title="Zoom out (−)" onclick={() => zoomBy(0.8)}>
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
					</button>
					<button aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomBy(1.25)}>
						<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8M6 2v8" /></svg>
					</button>
					<button title="Fit all tasks (F)" onclick={refit}>Fit</button>
				</div>
			{/if}
		</div>
	</nav>
</div>

<style>
	.tree-drawer {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		width: min(36rem, 85%);
		z-index: 7;
		translate: -100% 0;
		transition: translate 200ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.tree-drawer.open { translate: 0 0; }
	/* Beside an open details drawer (44rem on the right), take what's left of the map. */
	:global(.stage.drawn) > .tree-drawer { width: max(20rem, min(36rem, 100% - 46rem)); }
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
		display: flex;
		flex-direction: column;
		background: var(--fog);
		border-right: 1px solid var(--line);
		box-shadow: 12px 0 32px rgb(15 24 33 / 0.12);
		visibility: hidden;
		transition: visibility 0s 200ms;
	}
	.open .panel { visibility: visible; transition: none; }
	header { padding: 0.75rem 0.75rem 0.7rem 1rem; border-bottom: 1px solid var(--line-2); background: var(--paper); }
	.top { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 0.6rem; }
	h2 { font-size: 0.9375rem; }
	.top a { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.8125rem; color: var(--ink-2); text-decoration: none; }
	.top a:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
	.top a path { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
	/* Toggles, all on by default: on reads as a plain chip, off fades to a dashed outline. */
	.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
	.chips button { padding: 0.15rem 0.55rem 0.15rem 0.4rem; font-size: 0.75rem; gap: 0.3rem; }
	.chips button[aria-pressed="true"] { background: var(--raised); border-color: var(--line); color: var(--ink); }
	.chips button[aria-pressed="true"]:hover { border-color: var(--ink-3); }
	.chips button[aria-pressed="false"] { background: none; border-style: dashed; color: var(--ink-3); }
	.chips button[aria-pressed="false"] :global(.mark) { opacity: 0.4; }
	.chips :global(.mark) { width: 11px; height: 11px; }
	.muted { padding: 1rem; font-size: 0.875rem; }

	/* The canvas: a world moved and scaled inside a clipped view. */
	.view { position: relative; flex: 1; min-height: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; }
	.view.grabbing { cursor: grabbing; }
	.view:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
	.edges { position: absolute; overflow: visible; width: 1px; height: 1px; }
	.edges path { fill: none; stroke: var(--ink-3); stroke-width: 1.25; opacity: 0.55; transition: opacity 120ms ease-out; }
	.edges path.on { stroke: var(--ink); stroke-width: 1.75; opacity: 1; }
	.edges path.dim { opacity: 0.15; }
	.edges marker path { fill: none; stroke: context-stroke; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; opacity: 1; }

	.world a {
		position: absolute;
		box-sizing: border-box;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.45rem 0.55rem;
		color: var(--ink);
		text-decoration: none;
		font-size: 0.8125rem;
		line-height: 1.3;
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		box-shadow: 0 1px 2px rgb(15 24 33 / 0.06);
	}
	.world a > * { transition: opacity 120ms ease-out; }
	/* The mark sits on the title's first line. */
	.world a > :global(.icon) { height: 1.05rem; align-items: center; }
	.world a.done { background: var(--paper); color: var(--ink-2); }
	.world a.dim { border-color: var(--line-2); box-shadow: none; }
	.world a.dim > * { opacity: 0.35; }
	.world a:hover { border-color: var(--ink-3); }
	.world a[aria-current="page"] { font-weight: 600; border-color: var(--ink-2); box-shadow: 0 0 0 1px var(--ink-2), 0 2px 6px rgb(15 24 33 / 0.12); }
	.world a:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
	.body { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 0.15rem; }
	.body .badge { font-weight: 500; }
	.t { max-width: 100%; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
	.body:has(.badge) .t { -webkit-line-clamp: 1; line-clamp: 1; }
	.also { flex: none; margin-top: 0.05rem; padding: 0 0.35rem; border: 1px solid var(--line); border-radius: 999px; font-size: 0.6875rem; line-height: 1rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }

	.zoom { position: absolute; right: 0.75rem; bottom: 0.75rem; display: flex; gap: 2px; }
	.zoom button { padding: 0.3rem 0.6rem; min-width: 2rem; justify-content: center; background: var(--overlay); font-size: 0.8125rem; }
	.zoom svg path { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
</style>
