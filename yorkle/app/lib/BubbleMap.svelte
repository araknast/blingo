<script lang="ts">
	import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
	import { onDestroy, tick, untrack } from "svelte";
	import { fade } from "svelte/transition";
	import { MAX_DOTS, dotOffset, edge, fileCount, hash, orderMembers, radius } from "./layout";
	import type { Bubble, Member, RepoState } from "./types";
	import { menuGesture, plural, short } from "./util";

	let {
		data,
		hrefFor,
		onconflict,
		oncontext,
		demo = false,
	}: {
		data: RepoState | null;
		hrefFor?: (bubble: string) => string;
		onconflict?: (a: string, b: string) => void;
		oncontext?: (at: { x: number; y: number; bubble: string | null }) => void;
		demo?: boolean;
	} = $props();

	type Node = SimulationNodeDatum & { id: string; r: number; b: Bubble; members: Member[]; files: number; film: number };
	type Pt = { x: number; y: number };
	type Flyer = { key: number; fork: string; bubble: string; status: Member["status"]; from: Pt; t0: number };

	const FLY_MS = 1100;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

	let box: HTMLDivElement;
	let svg: SVGSVGElement;
	let w = $state(0);
	let h = $state(0);
	let dockH = $state(0);
	let k = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	let userMoved = false;
	let fitted = false;

	const nodes = new Map<string, Node>();
	let view = $state.raw<Node[]>([]);
	let links = $state.raw<[string, string][]>([]);
	let flyers = $state.raw<Flyer[]>([]);
	let now = $state(0);
	let ripples = $state<Record<string, number>>({});
	let hovered = $state<string | null>(null);
	let dockPos = new Map<string, Pt>(); // world position of each dock chip, as last rendered
	let flyKey = 0;

	const sim = forceSimulation<Node>([])
		.force("collide", forceCollide<Node>((n) => n.r + 36).strength(1))
		.force("charge", forceManyBody<Node>().strength(-40))
		.force("x", forceX<Node>(0).strength(0.03))
		.force("y", forceY<Node>(0).strength(0.07))
		.alphaDecay(0.035)
		.on("tick", draw);
	onDestroy(() => sim.stop());

	function draw() {
		// Fresh copies: the each block only re-renders items whose reference changed.
		view = [...nodes.values()].map((n) => ({ ...n }));
		if (!userMoved) fit(fitted);
	}

	// World ↔ container pixels. World (0,0) sits in the middle of the area above the dock.
	const cx = $derived(w / 2 + tx);
	const cy = $derived((h - dockH) / 2 + ty);
	const toWorld = (sx: number, sy: number): Pt => ({ x: (sx - cx) / k, y: (sy - cy) / k });

	function fit(smooth: boolean) {
		const ns = [...nodes.values()];
		if (!ns.length || !w) return;
		const x0 = Math.min(...ns.map((n) => n.x! - n.r)), x1 = Math.max(...ns.map((n) => n.x! + n.r));
		const y0 = Math.min(...ns.map((n) => n.y! - n.r)), y1 = Math.max(...ns.map((n) => n.y! + n.r + 34));
		const pad = demo ? 24 : 48;
		const kk = Math.max(0.25, Math.min(demo ? 1.7 : 1.4, (w - pad * 2) / (x1 - x0), (h - dockH - pad * 2) / (y1 - y0)));
		const t = { k: kk, x: -((x0 + x1) / 2) * kk, y: -((y0 + y1) / 2) * kk };
		const a = smooth ? 0.12 : 1;
		k += (t.k - k) * a;
		tx += (t.x - tx) * a;
		ty += (t.y - ty) * a;
		fitted = true;
	}

	function memberPos(n: Node, fork: string): Pt | null {
		const i = n.members.findIndex((m) => m.name === fork);
		if (i < 0 || i >= MAX_DOTS) return null;
		const o = dotOffset(i, Math.min(n.members.length, MAX_DOTS), n.r);
		return { x: n.x! + o.x, y: n.y! + o.y };
	}

	function cacheDock() {
		if (!box) return;
		const r0 = box.getBoundingClientRect();
		dockPos = new Map();
		for (const el of box.querySelectorAll<HTMLElement>("[data-fork]")) {
			const r = el.getBoundingClientRect();
			dockPos.set(el.dataset.fork!, toWorld(r.left - r0.left + 10, r.top - r0.top + r.height / 2));
		}
	}

	// Merge new API state into the running simulation; nodes keep their place between polls.
	function apply(d: RepoState) {
		const before = new Map<string, Pt & { bubble: string | null }>();
		for (const n of nodes.values()) for (const m of n.members) {
			const p = memberPos(n, m.name);
			if (p) before.set(m.name, { ...p, bubble: n.id });
		}
		for (const [f, p] of dockPos) if (!before.has(f)) before.set(f, { ...p, bubble: null });

		const animate = fitted && !reduced;
		const t0 = performance.now();
		const newFlyers: Flyer[] = [];
		let changed = false;
		const seen = new Set<string>();
		for (const b of d.bubbles) {
			seen.add(b.id);
			const r = radius(b);
			let n = nodes.get(b.id);
			if (!n) {
				const from = before.get(b.id);
				const a = Math.random() * Math.PI * 2;
				n = { id: b.id, x: from?.x ?? Math.cos(a) * 120, y: from?.y ?? Math.sin(a) * 80, r, b, members: [], files: 0, film: hash(b.id) % 4 };
				nodes.set(b.id, n);
				changed = true;
			}
			if (Math.abs(n.r - r) > 0.5) changed = true;
			const old = new Set(n.members.map((m) => m.name));
			n.r = r;
			n.b = b;
			n.members = orderMembers(b.members);
			n.files = fileCount(b);
			if (!animate) continue;
			for (const m of n.members) {
				if (old.has(m.name)) continue;
				const p = before.get(m.name);
				if (p && p.bubble !== b.id) newFlyers.push({ key: flyKey++, fork: m.name, bubble: b.id, status: m.status, from: p, t0 });
				else ripple(b.id);
			}
		}
		for (const id of nodes.keys()) if (!seen.has(id)) (nodes.delete(id), (changed = true));

		links = d.conflicts.filter(([a, b]) => nodes.has(a) && nodes.has(b));
		sim.nodes([...nodes.values()]);
		sim.force(
			"link",
			forceLink<Node, { source: string | Node; target: string | Node }>(links.map(([a, b]) => ({ source: a, target: b })))
				.id((n) => n.id)
				.distance((l) => (l.source as Node).r + (l.target as Node).r + 110)
				.strength(0.15),
		);
		if (reduced) {
			sim.stop();
			for (let i = 0; i < 300; i++) sim.tick();
			draw();
		} else if (changed) sim.alpha(fitted ? 0.5 : 1).restart();
		else draw();

		if (newFlyers.length) {
			flyers = [...flyers, ...newFlyers];
			fly();
		}
		tick().then(cacheDock);
	}

	function ripple(id: string) {
		if (!reduced) ripples[id] = (ripples[id] ?? 0) + 1;
	}

	let raf = 0;
	function fly() {
		if (raf) return;
		const step = () => {
			now = performance.now();
			const done = flyers.filter((f) => now - f.t0 >= FLY_MS);
			if (done.length) {
				flyers = flyers.filter((f) => !done.includes(f));
				for (const f of done) ripple(f.bubble);
			}
			raf = flyers.length ? requestAnimationFrame(step) : 0;
		};
		raf = requestAnimationFrame(step);
	}
	onDestroy(() => cancelAnimationFrame(raf));

	function flyerPos(f: Flyer): Pt | null {
		const n = nodes.get(f.bubble);
		const to = n && memberPos(n, f.fork);
		if (!to) return null;
		const t = Math.min(1, (now - f.t0) / FLY_MS);
		const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
		// A slight arc, like something drifting rather than sliding.
		const lift = Math.sin(Math.PI * t) * 40;
		return { x: f.from.x + (to.x - f.from.x) * e, y: f.from.y + (to.y - f.from.y) * e - lift };
	}
	const flying = $derived(new Set(flyers.map((f) => f.fork)));

	$effect(() => {
		if (data && w) untrack(() => apply(data));
	});
	$effect(() => {
		// Refit when the box or the dock changes size.
		w;
		h;
		dockH;
		untrack(() => !userMoved && fit(false));
		tick().then(cacheDock);
	});

	// ---- Pan, zoom, drag ----
	let drag: { id: string | null; x: number; y: number; moved: boolean; pointer: number } | null = null;
	let suppressClick = false;

	// ---- Context menu: right-click, Shift+F10 / Menu key, or a long press on touch ----
	let press: ReturnType<typeof setTimeout> | undefined;
	let pressedAt = 0;

	function context(e: MouseEvent) {
		if (demo || !oncontext) return;
		e.preventDefault();
		if (Date.now() - pressedAt < 1000) return; // Android also fires contextmenu after our long press
		const bubble = (e.target as Element).closest<SVGAElement>("a.bubble")?.dataset.id ?? null;
		let { clientX: x, clientY: y } = e;
		if (!x && !y) {
			// Opened from the keyboard: anchor to the focused bubble, or the map's corner.
			const r = (e.target as Element).getBoundingClientRect();
			[x, y] = bubble ? [r.left + r.width / 2, r.top + r.height / 2] : [r.left + 24, r.top + 24];
		}
		oncontext({ x, y, bubble });
	}

	function down(e: PointerEvent, id: string | null) {
		if (demo || e.button !== 0) return;
		drag = { id, x: e.clientX, y: e.clientY, moved: false, pointer: e.pointerId };
		clearTimeout(press);
		if (e.pointerType === "touch" && oncontext) {
			const at = { x: e.clientX, y: e.clientY, bubble: id };
			press = setTimeout(() => {
				if (!drag || drag.moved) return;
				drag = null;
				suppressClick = true;
				pressedAt = Date.now();
				oncontext(at);
			}, 550);
		}
	}
	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointer) return;
		const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
		if (!drag.moved && Math.hypot(dx, dy) < 5) return;
		if (!drag.moved) {
			clearTimeout(press);
			drag.moved = true;
			svg.setPointerCapture(e.pointerId);
		}
		userMoved = true;
		if (drag.id) {
			const n = nodes.get(drag.id)!;
			const r0 = box.getBoundingClientRect();
			const p = toWorld(e.clientX - r0.left, e.clientY - r0.top);
			n.fx = p.x;
			n.fy = p.y;
			sim.alphaTarget(0.25).restart();
		} else {
			tx += dx;
			ty += dy;
			drag.x = e.clientX;
			drag.y = e.clientY;
		}
	}
	function up(e: PointerEvent) {
		clearTimeout(press);
		if (!drag || e.pointerId !== drag.pointer) return;
		if (drag.id) {
			const n = nodes.get(drag.id);
			if (n) n.fx = n.fy = null;
			sim.alphaTarget(0);
		}
		suppressClick = drag.moved;
		drag = null;
		cacheDock();
	}
	function zoomBy(f: number, sx = w / 2, sy = (h - dockH) / 2) {
		const p = toWorld(sx, sy);
		const nk = Math.max(0.25, Math.min(3, k * f));
		tx = sx - w / 2 - p.x * nk;
		ty = sy - (h - dockH) / 2 - p.y * nk;
		k = nk;
		userMoved = true;
		cacheDock();
	}
	function refit() {
		userMoved = false;
		fit(false);
		cacheDock();
	}
	$effect(() => {
		if (demo) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			const r0 = box.getBoundingClientRect();
			zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r0.left, e.clientY - r0.top);
		};
		svg.addEventListener("wheel", onWheel, { passive: false });
		return () => svg.removeEventListener("wheel", onWheel);
	});

	// ---- Hover card ----
	const hoverNode = $derived(hovered ? view.find((n) => n.id === hovered) : undefined);
	const cardStyle = $derived.by(() => {
		if (!hoverNode) return "";
		const sx = cx + hoverNode.x! * k, sy = cy + hoverNode.y! * k, r = hoverNode.r * k;
		const left = sx + r + 300 < w ? sx + r + 14 : Math.max(8, sx - r - 14 - 280);
		return `left:${left}px;top:${Math.max(8, Math.min(sy - 40, h - dockH - 220))}px`;
	});

	// Dock: forks not in a bubble yet.
	const running = $derived(data?.agents.filter((a) => a.status === "running") ?? []);
	const dockCount = $derived(running.length + (data?.waiting.length ?? 0) + (data?.placing.length ?? 0));

	const hl = (r: number) => {
		// Specular glint: a short arc on the upper left of the film.
		const a0 = (205 * Math.PI) / 180, a1 = (250 * Math.PI) / 180, rr = r * 0.8;
		return `M ${Math.cos(a0) * rr} ${Math.sin(a0) * rr} A ${rr} ${rr} 0 0 1 ${Math.cos(a1) * rr} ${Math.sin(a1) * rr}`;
	};
	const dotR = (s: Member["status"]) => (s === "rep" ? 6.5 : 5);
	const stateLabel = (n: Node) => (!n.b.visible ? "Merging" : n.b.locked ? "Locked" : plural(n.files, "file"));
</script>

<div class="map" class:demo bind:this={box} bind:clientWidth={w} bind:clientHeight={h}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (role is "application" whenever it is focusable) -->
	<svg
		bind:this={svg}
		width={w}
		height={h}
		role={demo ? "img" : "application"}
		aria-label={demo
			? "An animated example of forks joining bubbles"
			: "Bubble map. Drag to pan, scroll to zoom, Tab to move between bubbles. Right-click or Shift+F10 for actions."}
		tabindex={demo ? undefined : 0}
		oncontextmenu={context}
		onpointerdown={(e) => down(e, null)}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
	>
		<defs>
			{#each [0, 1, 2, 3] as v}
				<linearGradient id="film-{v}" gradientTransform="rotate({v * 90 + 30} .5 .5)">
					<stop offset="0" stop-color="var(--teal)" />
					<stop offset=".5" stop-color="var(--lilac)" />
					<stop offset="1" stop-color="var(--amber)" />
				</linearGradient>
			{/each}
			<linearGradient id="film-locked" gradientTransform="rotate(45 .5 .5)">
				<stop offset="0" stop-color="var(--ink-3)" />
				<stop offset="1" stop-color="var(--line)" />
			</linearGradient>
			<radialGradient id="soap" cx=".38" cy=".32" r=".85">
				<stop offset="0" stop-color="var(--soap-core)" />
				<stop offset=".65" stop-color="var(--soap-mid)" />
				<stop offset="1" stop-color="var(--soap-edge)" />
			</radialGradient>
		</defs>

		<g transform="translate({cx} {cy}) scale({k})">
			{#each links as [a, b] (a + "|" + b)}
				{@const na = view.find((n) => n.id === a)}
				{@const nb = view.find((n) => n.id === b)}
				{#if na && nb}
					{@const p = edge(na.x!, na.y!, na.r + 6, nb.x!, nb.y!)}
					{@const q = edge(nb.x!, nb.y!, nb.r + 6, na.x!, na.y!)}
					<g
						class="conflict"
						role="button"
						tabindex={demo ? undefined : 0}
						aria-label="Conflict between bubbles {short(a)} and {short(b)}. Open to ferge them."
						onclick={() => onconflict?.(a, b)}
						onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onconflict?.(a, b))}
						transition:fade={{ duration: 300 }}
					>
						<line class="hit" x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
						<line class="dash" x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
						<g transform="translate({(p.x + q.x) / 2} {(p.y + q.y) / 2})">
							<rect x="-7" y="-7" width="14" height="14" rx="2" transform="rotate(45)" />
							<text y="4">!</text>
						</g>
					</g>
				{/if}
			{/each}

			{#each view as n (n.id)}
				{@const dots = n.members.slice(0, MAX_DOTS)}
				<g transform="translate({n.x} {n.y})" transition:fade={{ duration: 400 }}>
				<a
					href={demo ? undefined : hrefFor?.(n.id)}
					class="bubble"
					data-id={n.id}
					class:merging={!n.b.visible}
					class:locked={n.b.locked}
					class:hot={hovered === n.id}
					aria-label="Bubble {short(n.id)}: {plural(n.members.length, 'fork')}, {stateLabel(n)}. Open its code."
					onpointerdown={(e) => (e.stopPropagation(), down(e, n.id))}
					onpointerenter={() => !drag && (hovered = n.id)}
					onpointerleave={() => hovered === n.id && (hovered = null)}
					onfocus={() => (hovered = n.id)}
					onblur={() => hovered === n.id && (hovered = null)}
					onclick={(e) => suppressClick && (e.preventDefault(), (suppressClick = false))}
				>
					<circle class="body" r={n.r} />
					{#key ripples[n.id]}
						{#if ripples[n.id]}<circle class="ripple" r={n.r} stroke="url(#film-{n.film})" />{/if}
					{/key}
					<circle class="rim" r={n.r} stroke={n.b.locked ? "url(#film-locked)" : `url(#film-${n.film})`} />
					<path class="glint" d={hl(n.r)} />
					{#each dots as m, i (m.name)}
						{#if !flying.has(m.name)}
							{@const o = dotOffset(i, dots.length, n.r)}
							<circle class="fork {m.status}" cx={o.x} cy={o.y} r={dotR(m.status)} />
						{/if}
					{/each}
					{#if n.b.locked}
						<g class="lock" transform="translate({n.r * 0.7} {-n.r * 0.7})">
							<circle r="10" />
							<rect x="-4" y="-1" width="8" height="6" rx="1" />
							<path d="M -2.5 -1 v -2 a 2.5 2.5 0 0 1 5 0 v 2" />
						</g>
					{/if}
					<text class="id" y={n.r + 17}>{short(n.id)}</text>
					<text class="sub" y={n.r + 31}>{stateLabel(n)}</text>
				</a>
				</g>
			{/each}

			{#each flyers as f (f.key)}
				{@const p = flyerPos(f)}
				{#if p}<circle class="fork flyer {f.status}" cx={p.x} cy={p.y} r={dotR(f.status)} />{/if}
			{/each}
		</g>
	</svg>

	{#if data && !data.bubbles.length && !demo}
		<div class="empty">
			<p>No bubbles yet.</p>
			<p class="muted">{menuGesture} the map to start an agent or push a fork. Its changes land here as the first bubble.</p>
		</div>
	{/if}

	{#if !demo}
		<div class="legend" aria-hidden="true">
			<span><i class="dot rep"></i>Representative</span>
			<span><i class="dot pending"></i>Waiting to merge</span>
			<span><i class="dot merged"></i>Merged</span>
			<span><i class="dot conflict"></i>Conflicted</span>
			<span class="hint">Right-click for actions</span>
		</div>
		<div class="zoom">
			<button aria-label="Zoom in" onclick={() => zoomBy(1.25)}>+</button>
			<button aria-label="Zoom out" onclick={() => zoomBy(0.8)}>−</button>
			<button aria-label="Fit to view" onclick={refit}>Fit</button>
		</div>
	{/if}

	{#if hoverNode && !demo}
		{@const n = hoverNode}
		<div class="card" style={cardStyle} aria-hidden="true">
			<div class="card-head">
				<strong class="mono">{short(n.id)}</strong>
				{#if !n.b.visible}<span class="tag">Merging</span>{/if}
				{#if n.b.locked}<span class="tag">Locked</span>{/if}
			</div>
			<p class="muted">{plural(n.members.length, "fork")}, {plural(n.files, "file")}</p>
			<ul>
				{#each n.members.slice(0, 6) as m}
					<li><i class="dot {m.status}"></i><span class="mono">{short(m.name)}</span><span class="muted">{m.status === "rep" ? "representative" : m.status}</span></li>
				{/each}
				{#if n.members.length > 6}<li class="muted">and {n.members.length - 6} more</li>{/if}
			</ul>
			{#if n.files}
				<div class="files">
					{#each [...new Set(n.members.flatMap((m) => m.files))].slice(0, 5) as f}<code>{f}</code>{/each}
				</div>
			{/if}
		</div>
	{/if}

	{#if dockCount}
		<div class="dock" bind:clientHeight={dockH} aria-label="Forks not in a bubble yet">
			{#if running.length}
				<div class="group">
					<span class="label">Agents working</span>
					{#each running as a (a.fork)}
						<span class="chip" data-fork={a.fork} title={a.prompt}><i class="dot working pulse"></i><span class="prompt">{a.prompt}</span></span>
					{/each}
				</div>
			{/if}
			{#if data?.waiting.length}
				<div class="group">
					<span class="label">Waiting for a push</span>
					{#each data.waiting as f (f)}
						<span class="chip" data-fork={f}><i class="dot waiting"></i><span class="mono">{short(f)}</span></span>
					{/each}
				</div>
			{/if}
			{#if data?.placing.length}
				<div class="group">
					<span class="label">Finding a bubble</span>
					{#each data.placing as f (f)}
						<span class="chip" data-fork={f}><i class="dot placing pulse"></i><span class="mono">{short(f)}</span></span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.map {
		--soap-core: rgb(255 255 255 / 0.85);
		--soap-mid: rgb(255 255 255 / 0.35);
		--soap-edge: rgb(185 163 240 / 0.18);
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background:
			radial-gradient(circle at 1px 1px, var(--line) 1px, transparent 0) 0 0 / 24px 24px,
			var(--fog);
	}
	@media (prefers-color-scheme: dark) {
		.map {
			--soap-core: rgb(255 255 255 / 0.1);
			--soap-mid: rgb(255 255 255 / 0.03);
			--soap-edge: rgb(185 163 240 / 0.12);
		}
	}
	.map.demo { background: none; }
	svg { display: block; touch-action: none; user-select: none; cursor: grab; }
	svg:active { cursor: grabbing; }
	.demo svg { cursor: default; }

	.bubble { cursor: pointer; outline: none; }
	.bubble .body { fill: url(#soap); }
	.bubble .rim { fill: none; stroke-width: 3; transition: stroke-width 150ms; }
	.bubble.hot .rim, .bubble:focus-visible .rim { stroke-width: 5; }
	.bubble:focus-visible .body { stroke: var(--focus); stroke-width: 2; stroke-dasharray: 3 4; }
	.bubble .glint { fill: none; stroke: rgb(255 255 255 / 0.9); stroke-width: 3; stroke-linecap: round; }
	.bubble.merging .rim { stroke-dasharray: 14 9; animation: swirl 1.4s linear infinite; }
	.bubble.merging .body { opacity: 0.6; }
	.bubble.locked .glint { opacity: 0.4; }
	@keyframes swirl { to { stroke-dashoffset: -46; } }

	.ripple {
		fill: none;
		stroke-width: 3;
		transform-box: fill-box;
		transform-origin: center;
		animation: ripple 900ms ease-out forwards;
		pointer-events: none;
	}
	@keyframes ripple { from { opacity: 0.9; transform: scale(1); } to { opacity: 0; transform: scale(1.35); } }

	.fork { stroke-width: 2; }
	.fork.rep { fill: var(--paper); stroke: var(--merged); stroke-width: 2.5; }
	.fork.pending { fill: var(--paper); stroke: var(--pending); }
	.fork.merged { fill: var(--merged); stroke: none; }
	.fork.conflict { fill: var(--conflict); stroke: none; }
	.flyer { pointer-events: none; filter: drop-shadow(0 1px 2px rgb(15 24 33 / 0.3)); }

	.lock circle { fill: var(--paper); stroke: var(--ink-3); stroke-width: 1.5; }
	.lock rect { fill: var(--ink-2); }
	.lock path { fill: none; stroke: var(--ink-2); stroke-width: 1.5; }

	text { text-anchor: middle; fill: var(--ink-2); pointer-events: none; }
	text.id { font-family: var(--mono); font-size: 11px; fill: var(--ink); }
	text.sub { font-size: 11px; fill: var(--ink-3); }
	.merging text.sub { font-style: italic; }

	.conflict { cursor: pointer; outline: none; }
	.conflict .hit { stroke: transparent; stroke-width: 18; }
	.conflict .dash { stroke: var(--conflict); stroke-width: 2; stroke-dasharray: 6 5; }
	.conflict rect { fill: var(--conflict); }
	.conflict text { fill: #fff; font-size: 11px; font-weight: 700; }
	.conflict:hover .dash, .conflict:focus-visible .dash { stroke-width: 3.5; }
	.conflict:focus-visible rect { stroke: var(--focus); stroke-width: 2; }

	.empty { position: absolute; left: 2rem; top: 4.5rem; max-width: 26rem; }
	.empty p:first-child { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.3rem; }

	.legend {
		position: absolute;
		left: 1rem;
		top: 1rem;
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem 1rem;
		font-size: 0.75rem;
		color: var(--ink-2);
		max-width: calc(100% - 9rem);
	}
	.legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
	.legend .hint { color: var(--ink-3); padding-left: 1rem; border-left: 1px solid var(--line); }
	svg:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.zoom { position: absolute; right: 1rem; top: 1rem; display: flex; gap: 2px; }
	.zoom button { padding: 0.25rem 0.6rem; min-width: 2rem; justify-content: center; }

	.card {
		position: absolute;
		width: 280px;
		padding: 0.8rem 0.9rem;
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		box-shadow: 0 10px 30px rgb(15 24 33 / 0.16);
		font-size: 0.8125rem;
		pointer-events: none;
		z-index: 5;
	}
	.card-head { display: flex; align-items: center; gap: 0.5rem; }
	.card-head strong { font-size: 0.875rem; }
	.tag { font-size: 0.6875rem; padding: 0.05rem 0.4rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
	.card ul { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.2rem; }
	.card li { display: flex; align-items: center; gap: 0.5rem; }
	.card .files { margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid var(--line-2); display: grid; gap: 0.1rem; }
	.card code { font-size: 0.75rem; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.dock {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		gap: 1.5rem;
		padding: 0.7rem 1rem;
		background: color-mix(in srgb, var(--paper) 88%, transparent);
		backdrop-filter: blur(6px);
		border-top: 1px solid var(--line);
		overflow-x: auto;
		font-size: 0.8125rem;
	}
	.group { display: flex; align-items: center; gap: 0.5rem; flex: none; }
	.label { color: var(--ink-3); margin-right: 0.15rem; }
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.6rem 0.2rem 0.45rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--raised);
		max-width: 16rem;
	}
	.chip .prompt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.chip .mono { font-size: 0.75rem; }

	@media (max-width: 768px) {
		.legend { display: none; }
		.card { display: none; }
	}
</style>
