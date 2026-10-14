<script lang="ts">
	// The repo's tasks as a graph of what waits on what, filling the map's stage: every dep an edge, solid
	// once it has landed. Chips along the bottom show or hide each kind of task. Drag to pan, wheel or
	// buttons to zoom; hovering or opening a task lights up everything it waits on and everything that waits
	// on it. `controls` renders first in the top bar (the map's view toggle).
	import type { Snippet } from "svelte";
	import Mark from "./Mark.svelte";
	import { GAP_Y, KINDS, kindOf, lineage, NODE_H, NODE_W, taskGraph, type Kind } from "./taskGraph";
	import type { RepoState } from "./types";

	let { data, href, current, controls }: { data: RepoState | null; href: (id: string) => string; current?: string; controls?: Snippet } = $props();

	const label = Object.fromEntries(KINDS.map((k) => [k.id, k])) as Record<Kind, (typeof KINDS)[number]>;
	let shown = $state(Object.fromEntries(KINDS.map((k) => [k.id, true])) as Record<Kind, boolean>);
	const kinds = $derived(new Map(data?.tasks.map((t) => [t.id, kindOf(t, data.closed)]) ?? []));
	const counts = $derived(
		[...kinds.values()].reduce((c, k) => ((c[k] = (c[k] ?? 0) + 1), c), {} as Partial<Record<Kind, number>>),
	);
	const tasks = $derived(data?.tasks.filter((t) => shown[kinds.get(t.id)!]) ?? []);
	const graph = $derived(taskGraph(tasks));
	const at = $derived(new Map(graph.nodes.map((n) => [n.task.id, n])));

	let hovered = $state<string | null>(null);
	const focus = $derived(hovered ?? (current && at.has(current) ? current : null));
	const lit = $derived(focus ? lineage(graph.edges, focus) : null);

	// ---- Pan and zoom ----
	let topH = $state(0), botH = $state(0); // the bars over the canvas; fitting keeps tasks out from under them
	let view: HTMLDivElement;
	let w = $state(0), h = $state(0);
	let tx = $state(0), ty = $state(0), k = $state(1);
	let userMoved = false;
	function fit() {
		if (!graph.nodes.length || !w || !h) return;
		const xs = graph.nodes.map((n) => n.x), bottom = Math.max(...graph.nodes.map((n) => n.y)) + NODE_H;
		const left = Math.min(...xs) - NODE_W / 2, right = Math.max(...xs) + NODE_W / 2;
		// Never so small the titles can't be read; then centre on the open task, if it's shown.
		const top = topH + 28, room = h - top - botH - 28;
		k = Math.max(0.5, Math.min(1, (w - 48) / (right - left), room / bottom));
		const cx = (right - left) * k > w - 48 && current && at.has(current) ? at.get(current)!.x : (left + right) / 2;
		tx = w / 2 - cx * k;
		ty = top + Math.max(0, (room - bottom * k) / 2);
	}
	// Refit when the graph's shape or the stage's size changes, unless the user has moved it.
	$effect(() => {
		graph;
		w;
		h;
		topH;
		botH;
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

<div class="graph">
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
		aria-roledescription="graph"
		aria-label="Task graph. Drag or arrow keys pan, wheel or plus and minus zoom, F fits. Tab moves between tasks."
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onkeydown={keys}
		onclickcapture={(e) => suppressClick && (e.preventDefault(), e.stopPropagation(), (suppressClick = false))}
	>
		{#if graph.nodes.length}
			<div class="world" style:transform="translate({tx}px, {ty}px) scale({k})">
				<svg class="edges" aria-hidden="true">
					<defs>
						<marker id="task-arrow" viewBox="0 0 8 8" refX="4" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1.5L4 5l3-3.5" /></marker>
					</defs>
					{#each graph.edges as e (e.from + ">" + e.to)}
						<path
							d={path(e.from, e.to)}
							marker-end="url(#task-arrow)"
							class:landed={kinds.get(e.from) === "completed"}
							class:on={lit?.has(e.from) && lit.has(e.to)}
							class:dim={lit && !(lit.has(e.from) && lit.has(e.to))}
						/>
					{/each}
				</svg>
				{#each graph.nodes as n (n.task.id)}
					{@const kind = kinds.get(n.task.id)!}
					<a
						href={href(n.task.id)}
						title={n.task.title}
						draggable="false"
						class="card k-{kind}"
						style:left="{n.x - NODE_W / 2}px"
						style:top="{n.y}px"
						style:width="{NODE_W}px"
						style:height="{NODE_H}px"
						aria-current={n.task.id === current ? "page" : undefined}
						class:dim={lit && !lit.has(n.task.id)}
						onpointerenter={() => !grabbing && (hovered = n.task.id)}
						onpointerleave={() => hovered === n.task.id && (hovered = null)}
						onfocus={() => (hovered = n.task.id)}
						onblur={() => hovered === n.task.id && (hovered = null)}
					>
						<Mark status={label[kind].glyph} label={label[kind].label} />
						<span class="body">
							<span class="t">{n.task.title}</span>
							<span class="meta"><span class="mono">#{n.task.id.slice(2)}</span> · {label[kind].label}</span>
						</span>
						{#if n.hidden}<span class="also" title="Also waits for {n.hidden} hidden {n.hidden === 1 ? 'task' : 'tasks'}">+{n.hidden}</span>{/if}
					</a>
				{/each}
			</div>
		{:else}
			<div class="empty">
				{#if !data}
					<p>Loading…</p>
				{:else if data.tasks.length}
					<p class="empty-title">Every task is hidden</p>
					<p>Turn a kind back on below.</p>
				{:else}
					<p class="empty-title">No tasks yet</p>
					<p>Tasks you or a superagent create show up here, each one below the tasks it waits on.</p>
				{/if}
			</div>
		{/if}
	</div>

	<div class="bar top" bind:offsetHeight={topH}>
		{@render controls?.()}
		<div class="zoom" role="group" aria-label="Zoom">
			<button aria-label="Zoom out" title="Zoom out (−)" onclick={() => zoomBy(0.8)}>
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
			</button>
			<button aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomBy(1.25)}>
				<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8M6 2v8" /></svg>
			</button>
			<button title="Fit all tasks (F)" onclick={refit}>Fit</button>
		</div>
		<p class="legend" aria-label="Edges">
			<span><svg width="22" height="8" aria-hidden="true"><path d="M1 4h20" /></svg>Landed</span>
			<span><svg width="22" height="8" aria-hidden="true"><path class="dash" d="M1 4h20" /></svg>Not landed yet</span>
		</p>
	</div>

	<div class="bar bottom" bind:offsetHeight={botH}>
		<div class="chips" role="group" aria-label="Show">
			{#each KINDS as kd (kd.id)}
				<button aria-pressed={shown[kd.id]} onclick={() => (shown[kd.id] = !shown[kd.id])}>
					<Mark status={kd.glyph} />{kd.label}<span class="count">{counts[kd.id] ?? 0}</span>
				</button>
			{/each}
		</div>
	</div>
</div>

<style>
	.graph {
		--overlay: color-mix(in srgb, var(--raised) 94%, transparent);
		position: absolute;
		inset: 0;
		background:
			radial-gradient(circle at 1px 1px, var(--line) 1px, transparent 0) 0 0 / 24px 24px,
			var(--fog);
	}
	/* Beside an open details drawer (44rem on the right), keep to what's left of the stage. */
	@media (min-width: 901px) { :global(.stage.drawn) > .graph { right: min(44rem, 100%); } }

	/* The canvas: a world moved and scaled inside a clipped view. */
	.view { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; user-select: none; }
	.view.grabbing { cursor: grabbing; }
	.view:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.world { position: absolute; top: 0; left: 0; transform-origin: 0 0; }

	.edges { position: absolute; overflow: visible; width: 1px; height: 1px; }
	.edges path { fill: none; stroke: var(--ink-3); stroke-width: 1.25; stroke-dasharray: 4 4; opacity: 0.7; transition: opacity 150ms ease-out, stroke 150ms ease-out; }
	.edges path.landed { stroke: var(--merged); stroke-dasharray: none; }
	.edges path.on { stroke-width: 2; opacity: 1; }
	.edges path.on:not(.landed) { stroke: var(--ink); }
	.edges path.dim { opacity: 0.12; }
	.edges marker path { stroke: context-stroke; stroke-width: 1.5; stroke-dasharray: none; stroke-linecap: round; stroke-linejoin: round; opacity: 1; }

	/* A card: the kind's colour runs down its left edge. */
	.card {
		--accent: var(--line);
		position: absolute;
		box-sizing: border-box;
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.55rem 0.6rem 0.5rem 0.75rem;
		color: var(--ink);
		text-decoration: none;
		font-size: 0.8125rem;
		line-height: 1.3;
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		box-shadow: inset 3px 0 0 var(--accent), 0 1px 2px rgb(15 24 33 / 0.06);
		transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
	}
	.card > * { transition: opacity 150ms ease-out; }
	.k-approval { --accent: var(--ink-2); }
	.k-waiting { --accent: var(--line); }
	.k-ready { --accent: var(--pending); }
	.k-in-progress { --accent: var(--working); }
	.k-completed { --accent: var(--merged); }
	.k-failed { --accent: var(--conflict); }
	.k-cancelled { --accent: var(--line); }
	.k-completed, .k-cancelled { background: var(--paper); color: var(--ink-2); }
	.k-cancelled .t { text-decoration: line-through; text-decoration-color: var(--ink-3); }
	.card > :global(.mark) { flex: none; margin-top: 0.1rem; }
	.card:hover { border-color: var(--ink-3); box-shadow: inset 3px 0 0 var(--accent), 0 4px 12px rgb(15 24 33 / 0.1); }
	.card[aria-current="page"] { border-color: var(--ink); box-shadow: inset 3px 0 0 var(--accent), 0 0 0 1px var(--ink), 0 6px 16px rgb(15 24 33 / 0.14); }
	.card.dim { border-color: var(--line-2); box-shadow: none; }
	.card.dim > * { opacity: 0.35; }
	.card:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
	.body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.2rem; }
	.t { font-weight: 500; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
	.card[aria-current="page"] .t { font-weight: 650; }
	.meta { margin-top: auto; font-size: 0.6875rem; color: var(--ink-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.meta .mono { font-size: 0.65rem; }
	.also { flex: none; padding: 0 0.35rem; border: 1px solid var(--line); border-radius: 999px; font-size: 0.6875rem; line-height: 1rem; color: var(--ink-3); font-variant-numeric: tabular-nums; }

	.empty { position: absolute; left: 1rem; top: 4.5rem; max-width: 28rem; padding: 1.25rem; background: var(--overlay); border: 1px solid var(--line); border-radius: var(--r-md); color: var(--ink-2); }
	.empty-title { font-weight: 600; color: var(--ink); margin-bottom: 0.25rem; }

	/* Bars over the canvas, as on the bubble map. */
	.bar { position: absolute; left: 1rem; right: 1rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 1rem; pointer-events: none; }
	.bar > * { pointer-events: auto; }
	.top { top: 1rem; gap: 0.5rem; }
	.bottom { bottom: 1rem; }
	.zoom { display: flex; gap: 2px; }
	.zoom button { padding: 0.3rem 0.6rem; min-width: 2rem; justify-content: center; background: var(--overlay); }
	.zoom svg path { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }

	/* Toggles, all on by default: on reads as a plain chip, off fades to a dashed outline. */
	.chips { display: flex; flex-wrap: wrap; gap: 0.3rem; padding: 0.3rem; background: var(--overlay); border: 1px solid var(--line); border-radius: var(--r-md); box-shadow: 0 2px 8px rgb(15 24 33 / 0.06); }
	.chips button { padding: 0.15rem 0.45rem 0.15rem 0.4rem; font-size: 0.75rem; gap: 0.3rem; }
	.chips button[aria-pressed="true"] { background: var(--raised); border-color: var(--line); color: var(--ink); }
	.chips button[aria-pressed="true"]:hover { border-color: var(--ink-3); }
	.chips button[aria-pressed="false"] { background: none; border-style: dashed; color: var(--ink-3); }
	.chips button[aria-pressed="false"] :global(.mark) { opacity: 0.4; }
	.chips :global(.mark) { width: 11px; height: 11px; }
	.count { min-width: 1.1rem; padding: 0 0.3rem; border-radius: 999px; background: var(--fog); font-size: 0.6875rem; line-height: 1rem; text-align: center; color: var(--ink-2); font-variant-numeric: tabular-nums; }
	.legend { margin-left: auto; display: flex; gap: 0.9rem; padding: 0.3rem 0.6rem; background: var(--overlay); border: 1px solid var(--line); border-radius: var(--r-sm); font-size: 0.75rem; color: var(--ink-2); }
	.legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
	.legend path { stroke: var(--merged); stroke-width: 1.5; }
	.legend path.dash { stroke: var(--ink-3); stroke-dasharray: 4 4; }
</style>
