<script lang="ts">
	import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
	import { onDestroy, untrack, type Snippet } from "svelte";
	import { fade } from "svelte/transition";
	import { docked, needs, type Docked, type Need } from "./attention";
	import Glyph from "./Glyph.svelte";
	import Mark from "./Mark.svelte";
	import { MAX_DOTS, dotOffset, edge, fileCount, hash, orderMembers, radius } from "./layout";
	import type { Bubble, Member, RepoState } from "./types";
	import { agentLabel, plural, short } from "./util";

	let {
		data,
		hrefFor,
		agentHref,
		looseHref,
		taskHref,
		pageHref,
		seen,
		onconflict,
		oncontext,
		stale = false,
		empty,
		demo = false,
	}: {
		data: RepoState | null;
		hrefFor?: (bubble: string, rest?: string) => string;
		agentHref?: (fork: string) => string;
		looseHref?: (fork: string) => string;
		taskHref?: (id: string) => string;
		pageHref?: (tab: string) => string;
		seen?: number;
		onconflict?: (a: string, b: string) => void;
		oncontext?: (at: { x: number; y: number; bubble: string | null }) => void;
		stale?: boolean;
		empty?: Snippet;
		demo?: boolean;
	} = $props();

	type Node = SimulationNodeDatum & { id: string; r: number; b: Bubble; members: Member[]; files: number; film: number };
	type Pt = { x: number; y: number };
	type Flyer = { key: number; fork: string; bubble: string; status: Member["status"]; from: Pt; t0: number };

	const FLY_MS = 1100;
	const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

	let box: HTMLDivElement;
	let svg: SVGSVGElement;
	let w = $state(0);
	let h = $state(0);
	let k = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	// Space the overlays take, so fitting keeps bubbles out from under them.
	let barH = $state(0);
	let dockH = $state(0);
	let needsW = $state(0);
	let needsH = $state(0);
	let userMoved = false;
	let fitted = false;

	const nodes = new Map<string, Node>();
	let view = $state.raw<Node[]>([]);
	const byId = $derived(new Map(view.map((n) => [n.id, n])));
	let merges = $state.raw<[string, string][]>([]);
	let links = $state.raw<[string, string][]>([]);
	let flyers = $state.raw<Flyer[]>([]);
	let now = $state(0);
	let ripples = $state<Record<string, number>>({});
	let hovered = $state<string | null>(null);
	// Bubbles a row of the "Needs you" list points at, while it's hovered or focused.
	let spot = $state<string[] | null>(null);
	let flyKey = 0;

	const need = $derived(data ? needs(data, seen) : []);
	const dock = $derived(data ? docked(data, need) : []);
	// Bubbles in a conflict or holding a series that didn't apply: drawn with a halo and drift to the top.
	const hot = $derived(new Set(need.flatMap((n) => (n.kind === "conflict" ? [n.a, n.b] : n.kind === "member" ? [n.bubble] : []))));

	const sim = forceSimulation<Node>([])
		.force("collide", forceCollide<Node>((n) => n.r + 36).strength(1))
		.force("charge", forceManyBody<Node>().strength(-40))
		.force("x", forceX<Node>(0).strength(0.03))
		.alphaDecay(0.035)
		.on("tick", draw);
	onDestroy(() => sim.stop());

	function draw() {
		// Fresh copies: the each block only re-renders items whose reference changed.
		view = [...nodes.values()].map((n) => ({ ...n }));
		if (!userMoved) fit(fitted);
	}

	// World ↔ container pixels. World (0,0) sits in the middle of the map.
	const cx = $derived(w / 2 + tx);
	const cy = $derived(h / 2 + ty);
	const toWorld = (sx: number, sy: number): Pt => ({ x: (sx - cx) / k, y: (sy - cy) / k });
	// Narrow maps stack "Needs you" under the dock instead of beside the bubbles.
	const narrow = $derived(w > 0 && w < 640);
	const inset = () => (narrow ? { top: barH, right: 0, bottom: dockH + needsH + 8 } : { top: barH, right: needsW, bottom: dockH });

	// The transform that shows these nodes in the free part of the map.
	function frame(ns: Node[], maxK: number) {
		const pad = demo ? 24 : 40;
		const ins = inset();
		const x0 = Math.min(...ns.map((n) => n.x! - n.r)), x1 = Math.max(...ns.map((n) => n.x! + n.r));
		const y0 = Math.min(...ns.map((n) => n.y! - n.r)), y1 = Math.max(...ns.map((n) => n.y! + n.r + 34));
		const aw = Math.max(80, w - ins.right - pad * 2), ah = Math.max(80, h - ins.top - ins.bottom - pad * 2);
		const kk = Math.max(0.25, Math.min(maxK, aw / (x1 - x0), ah / (y1 - y0)));
		return { k: kk, x: -((x0 + x1) / 2) * kk - ins.right / 2, y: -((y0 + y1) / 2) * kk + (ins.top - ins.bottom) / 2 };
	}

	function fit(smooth: boolean) {
		const ns = [...nodes.values()];
		if (!ns.length || !w) return;
		const t = frame(ns, demo ? 1.7 : 1.4);
		const a = smooth ? 0.12 : 1;
		k += (t.k - k) * a;
		tx += (t.x - tx) * a;
		ty += (t.y - ty) * a;
		fitted = true;
	}

	// Pans and zooms to these bubbles. For the "Needs you" list, search, and after a ferge.
	let glide = 0;
	export function focusOn(ids: string[]) {
		const ns = ids.map((id) => nodes.get(id)).filter((n): n is Node => !!n);
		if (!ns.length || !w) return;
		userMoved = true;
		const t = frame(ns, 1.2);
		const from = { k, x: tx, y: ty };
		cancelAnimationFrame(glide);
		if (reduced) return ((k = t.k), (tx = t.x), (ty = t.y));
		const t0 = performance.now();
		const step = () => {
			const p = Math.min(1, (performance.now() - t0) / 450);
			const e = 1 - Math.pow(2, -10 * p);
			k = from.k + (t.k - from.k) * e;
			tx = from.x + (t.x - from.x) * e;
			ty = from.y + (t.y - from.y) * e;
			if (p < 1) glide = requestAnimationFrame(step);
		};
		glide = requestAnimationFrame(step);
	}
	onDestroy(() => cancelAnimationFrame(glide));

	function memberPos(n: Node, fork: string): Pt | null {
		const i = n.members.findIndex((m) => m.name === fork);
		if (i < 0 || i >= MAX_DOTS) return null;
		const o = dotOffset(i, Math.min(n.members.length, MAX_DOTS), n.r);
		return { x: n.x! + o.x, y: n.y! + o.y };
	}

	// Where a fork outside the bubbles is on screen: its chip in the dock or the "Needs you" list, or its
	// dock group when that's folded.
	function chipPos(fork: string, status?: string): Pt | null {
		const el =
			box.querySelector(`[data-fork="${CSS.escape(fork)}"]`) ?? (status ? box.querySelector(`[data-group="${CSS.escape(status)}"]`) : null);
		if (!el) return null;
		const r = el.getBoundingClientRect(), r0 = box.getBoundingClientRect();
		return toWorld(r.left + Math.min(r.width / 2, 20) - r0.left, r.top + r.height / 2 - r0.top);
	}

	// Merge new API state into the running simulation; nodes keep their place between polls.
	let lastDock = new Map<string, string>();
	function apply(d: RepoState) {
		const before = new Map<string, Pt & { bubble: string | null }>();
		for (const n of nodes.values())
			for (const m of n.members) {
				const p = memberPos(n, m.name);
				if (p) before.set(m.name, { ...p, bubble: n.id });
			}

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
				const at = before.get(b.id) ?? spiral(nodes.size);
				n = { id: b.id, x: at.x, y: at.y, r, b, members: [], files: 0, film: hash(b.id) % 4 };
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
				const p = before.get(m.name) ?? (lastDock.has(m.name) ? chipPos(m.name, lastDock.get(m.name)) : null);
				if (p && !("bubble" in p && p.bubble === b.id)) newFlyers.push({ key: flyKey++, fork: m.name, bubble: b.id, status: m.status, from: p, t0 });
				else ripple(b.id);
			}
		}
		for (const id of nodes.keys()) if (!seen.has(id)) (nodes.delete(id), (changed = true));
		lastDock = new Map(docked(d).map((x) => [x.fork, x.status]));

		links = d.conflicts.filter(([a, b]) => nodes.has(a) && nodes.has(b));
		merges = (d.merging ?? []).filter(([a, b]) => nodes.has(a) && nodes.has(b));
		const up = new Set([...links.flat(), ...d.bubbles.filter((b) => b.members.some((m) => m.status === "failed")).map((b) => b.id)]);
		sim.nodes([...nodes.values()]);
		sim.force("y", forceY<Node>((n) => (up.has(n.id) ? -260 : 0)).strength((n) => (up.has(n.id) ? 0.1 : 0.07)));
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
	}

	// Where a new bubble starts: a sunflower spiral around the map's current centre, so new bubbles spread
	// out evenly instead of piling up where the simulation would push them.
	function spiral(i: number): Pt {
		const ns = [...nodes.values()];
		const c = ns.length ? { x: ns.reduce((s, n) => s + n.x!, 0) / ns.length, y: ns.reduce((s, n) => s + n.y!, 0) / ns.length } : { x: 0, y: 0 };
		const a = i * 2.399963;
		const d = 150 * Math.sqrt(i);
		return { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d * 0.7 };
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

	// Before the DOM updates, so a fork's dock chip is still there to fly from.
	$effect.pre(() => {
		if (data && w) untrack(() => apply(data));
	});
	$effect(() => {
		// Refit when the box or an overlay changes size.
		w;
		h;
		barH;
		dockH;
		needsW;
		needsH;
		untrack(() => !userMoved && fit(false));
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

	// On the splash (demo) bubbles can be dragged, but there's no panning, zooming or menu.
	function down(e: PointerEvent, id: string | null) {
		if (e.button !== 0 || (demo && id === null)) return;
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
		cancelAnimationFrame(glide);
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
	}
	function zoomBy(f: number, sx = w / 2, sy = h / 2) {
		const p = toWorld(sx, sy);
		const nk = Math.max(0.25, Math.min(3, k * f));
		tx = sx - w / 2 - p.x * nk;
		ty = sy - h / 2 - p.y * nk;
		k = nk;
		userMoved = true;
		cancelAnimationFrame(glide);
	}
	function refit() {
		userMoved = false;
		cancelAnimationFrame(glide);
		fit(false);
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

	// ---- Keyboard: arrows pan, + and − zoom, F or 0 fits ----
	function keys(e: KeyboardEvent) {
		if (demo || e.altKey || e.ctrlKey || e.metaKey) return;
		const step = e.shiftKey ? 240 : 80;
		const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
		if (pan) {
			e.preventDefault();
			userMoved = true;
			cancelAnimationFrame(glide);
			tx += pan[0];
			ty += pan[1];
		} else if (e.key === "+" || e.key === "=") zoomBy(1.25);
		else if (e.key === "-" || e.key === "_") zoomBy(0.8);
		else if (e.key === "f" || e.key === "F" || e.key === "0") refit();
		else return;
	}

	// ---- Dock: forks not in a bubble yet, grouped by what they're doing; folded when there are many ----
	const GROUPS = ["running", "loose", "placing", "pushed", "waiting"];
	const groups = $derived.by(() => {
		const by = new Map<string, Docked[]>();
		for (const x of dock) by.set(x.status, [...(by.get(x.status) ?? []), x]);
		return [...by].sort(([a], [b]) => (GROUPS.indexOf(a) + 99) % 99 - ((GROUPS.indexOf(b) + 99) % 99)).map(([status, items]) => ({ status, items }));
	});
	const folded = $derived(dock.length > (narrow ? 3 : 8));
	let openGroup = $state<string | null>(null);
	const chipHref = (x: Docked) => (demo ? undefined : x.person ? looseHref?.(x.fork) : agentHref?.(x.fork));

	// ---- "Needs you" ----
	let needsOpen = $state(!globalThis.matchMedia?.("(max-width: 768px)").matches);
	const nameById = (id: string) => byId.get(id)?.b.name || data?.bubbles.find((b) => b.id === id)?.name || short(id);
	const spotOf = (n: Need) => (n.kind === "conflict" ? [n.a, n.b] : n.kind === "member" || n.kind === "ferge" ? [n.bubble] : null);

	// ---- Hover card ----
	const hoverNode = $derived(hovered ? byId.get(hovered) : undefined);
	const cardStyle = $derived.by(() => {
		if (!hoverNode) return "";
		const sx = cx + hoverNode.x! * k, sy = cy + hoverNode.y! * k, r = hoverNode.r * k;
		const left = sx + r + 300 < w - inset().right ? sx + r + 14 : Math.max(8, sx - r - 14 - 280);
		return `left:${left}px;top:${Math.max(barH + 8, Math.min(sy - 40, h - dockH - 220))}px`;
	});

	const nameOf = (n: Node) => n.b.name || short(n.id);
	const announce = $derived(data ? `${plural(data.bubbles.length, "bubble")}. ${need.length ? `${plural(need.length, "thing needs", "things need")} you.` : "Nothing needs you."}` : "");

	const hl = (r: number) => {
		// Specular glint: a short arc on the upper left of the film.
		const a0 = (205 * Math.PI) / 180, a1 = (250 * Math.PI) / 180, rr = r * 0.8;
		return `M ${Math.cos(a0) * rr} ${Math.sin(a0) * rr} A ${rr} ${rr} 0 0 1 ${Math.cos(a1) * rr} ${Math.sin(a1) * rr}`;
	};
	const stateLabel = (n: Node) => {
		const s = !n.b.visible ? "Merging" : n.b.ferge && n.b.locked ? "Ferge, locked" : n.b.ferge ? "Ferge" : n.b.locked ? "Locked" : plural(n.files, "file");
		return n.members.length > MAX_DOTS ? `${s} · ${n.members.length} forks` : s;
	};
	const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	// Constant on-screen size for marks that must stay findable when zoomed out.
	const keep = $derived(Math.max(1, 1 / k));
</script>

{#snippet lockIcon()}
	<rect x="-4" y="-1" width="8" height="6" rx="1" class="i-fill" />
	<path d="M -2.5 -1 v -2 a 2.5 2.5 0 0 1 5 0 v 2" class="i-line" />
{/snippet}

{#snippet fergeIcon()}
	<path d="M -4 -4.5 L 0 0 L 4 -4.5 M 0 0 V 5" class="i-line" />
{/snippet}

{#snippet personIcon()}
	<circle cy="-2.5" r="2.6" class="i-fill" /><path d="M -4.6 5 a 4.6 4.6 0 0 1 9.2 0 z" class="i-fill" />
{/snippet}

<div class="map" class:demo class:calming={hot.size > 0} class:spotting={!!spot} bind:this={box} bind:clientWidth={w} bind:clientHeight={h}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (the map takes keys: arrows pan, + and − zoom, F fits) -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<svg
		bind:this={svg}
		width={w}
		height={h}
		role={demo ? "img" : "group"}
		aria-roledescription={demo ? undefined : "map"}
		aria-label={demo
			? "An animated example of forks joining bubbles"
			: "Bubble map. Arrow keys pan, plus and minus zoom, F fits. Tab moves between bubbles and conflicts. Right-click or Shift+F10 for actions."}
		tabindex={demo ? undefined : 0}
		oncontextmenu={context}
		onpointerdown={(e) => down(e, null)}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onkeydown={keys}
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
			{#each merges as [a, b] (a + "|" + b)}
				{@const na = byId.get(a)}
				{@const nb = byId.get(b)}
				{#if na && nb}
					{@const p = edge(na.x!, na.y!, na.r + 6, nb.x!, nb.y!)}
					{@const q = edge(nb.x!, nb.y!, nb.r + 6, na.x!, na.y!)}
					<line class="merging-line" x1={p.x} y1={p.y} x2={q.x} y2={q.y} transition:fade={{ duration: 300 }}>
						<title>{nameOf(na)} and {nameOf(nb)} are merging</title>
					</line>
				{/if}
			{/each}

			{#each view as n (n.id)}
				{@const dots = n.members.slice(0, MAX_DOTS)}
				{@const isHot = hot.has(n.id)}
				<g transform="translate({n.x} {n.y})" transition:fade={{ duration: 400 }}>
					<a
						href={demo ? undefined : hrefFor?.(n.id)}
						class="bubble"
						data-id={n.id}
						class:merging={!n.b.visible}
						class:locked={n.b.locked}
						class:ferge={n.b.ferge}
						class:hot={hovered === n.id}
						class:needs={isHot}
						class:lit={spot?.includes(n.id)}
						aria-label="{nameOf(n)}: {plural(n.members.length, 'fork')}, {stateLabel(n)}{isHot ? ', needs you' : ''}. Open its code."
						aria-describedby={hovered === n.id && !demo ? "map-card" : undefined}
						onpointerdown={(e) => (e.stopPropagation(), down(e, n.id))}
						onpointerenter={() => !drag && (hovered = n.id)}
						onpointerleave={() => hovered === n.id && (hovered = null)}
						onfocus={() => (hovered = n.id)}
						onblur={() => hovered === n.id && (hovered = null)}
						onclick={(e) => suppressClick && (e.preventDefault(), (suppressClick = false))}
					>
						{#if isHot}<circle class="halo" r={n.r + 10} />{/if}
						<g class="film">
							<circle class="body" r={n.r} />
							{#key ripples[n.id]}
								{#if ripples[n.id]}<circle class="ripple" r={n.r} stroke="url(#film-{n.film})" />{/if}
							{/key}
							<circle class="rim" r={n.r} stroke={n.b.ferge ? "var(--working)" : n.b.locked ? "url(#film-locked)" : `url(#film-${n.film})`} />
							<path class="glint" d={hl(n.r)} />
							{#each dots as m, i (m.name)}
								{#if !flying.has(m.name)}
									{@const o = dotOffset(i, dots.length, n.r)}
									<g class="fork" transform="translate({o.x} {o.y})"><Glyph status={m.status} /></g>
								{/if}
							{/each}
						</g>
						{#if n.b.locked}
							<g class="badge" transform="translate({n.r * 0.7} {-n.r * 0.7})"><circle r="10" />{@render lockIcon()}</g>
						{/if}
						{#if n.b.ferge}
							<g class="badge ferge-badge" transform="translate({-n.r * 0.7} {-n.r * 0.7})"><circle r="10" />{@render fergeIcon()}</g>
						{/if}
						<text class="id" y={n.r + 17}>{clip(nameOf(n), 28)}</text>
						<text class="sub" y={n.r + 31}>{stateLabel(n)}</text>
					</a>
				</g>
			{/each}

			<!-- Conflicts above bubbles, and the same size on screen at any zoom. -->
			{#each links as [a, b] (a + "|" + b)}
				{@const na = byId.get(a)}
				{@const nb = byId.get(b)}
				{#if na && nb}
					{@const p = edge(na.x!, na.y!, na.r + 6, nb.x!, nb.y!)}
					{@const q = edge(nb.x!, nb.y!, nb.r + 6, na.x!, na.y!)}
					<g
						class="conflict"
						class:lit={spot?.includes(a) && spot?.includes(b)}
						role={demo ? undefined : "button"}
						tabindex={demo ? undefined : 0}
						aria-label="{nameOf(na)} and {nameOf(nb)} conflict. Open to ferge them."
						onclick={() => onconflict?.(a, b)}
						onkeydown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onconflict?.(a, b))}
						transition:fade={{ duration: 300 }}
					>
						<line class="hit" x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
						<line class="dash" x1={p.x} y1={p.y} x2={q.x} y2={q.y} />
						<g transform="translate({(p.x + q.x) / 2} {(p.y + q.y) / 2}) scale({keep})">
							<rect x="-10" y="-10" width="20" height="20" rx="3" transform="rotate(45)" />
							<path class="bang" d="M 0 -5.5 V 1.5 M 0 4.6 V 5" />
						</g>
					</g>
				{/if}
			{/each}

			{#each flyers as f (f.key)}
				{@const p = flyerPos(f)}
				{#if p}<g class="fork flyer" transform="translate({p.x} {p.y})"><Glyph status={f.status} /></g>{/if}
			{/each}
		</g>
	</svg>

	{#if !data && !demo}
		<p class="loading" role="status">Loading the map…</p>
	{:else if data && !data.bubbles.length && !demo}
		<div class="empty">
			<p class="empty-title">No bubbles yet</p>
			<p>Start an agent or push a fork. Its changes land here as the first bubble, and each fork after that joins a bubble by the files it changes.</p>
			{@render empty?.()}
		</div>
	{/if}

	{#if stale && !demo}
		<p class="stale" role="status" style="bottom:{dockH + 16}px">Can't reach the server. Retrying; the map may be out of date.</p>
	{/if}

	{#if !demo}
		<p class="visually-hidden" aria-live="polite">{announce}</p>

		<div class="bar" bind:offsetHeight={barH}>
			<div class="zoom" role="group" aria-label="Zoom">
				<button aria-label="Zoom out" title="Zoom out (−)" onclick={() => zoomBy(0.8)}>
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8" /></svg>
				</button>
				<button aria-label="Zoom in" title="Zoom in (+)" onclick={() => zoomBy(1.25)}>
					<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8M6 2v8" /></svg>
				</button>
				<button title="Fit everything (F)" onclick={refit}>Fit</button>
			</div>
			<details class="key">
				<summary>Key</summary>
				<div class="key-body">
					<p class="key-head">Forks</p>
					<ul>
						<li><Mark status="rep" />Representative</li>
						<li><Mark status="pending" />Pending: queued to merge</li>
						<li><Mark status="merged" />Merged</li>
						<li><Mark status="failed" />Failed: its changes didn't apply</li>
						<li><Mark status="conflict" />Conflict</li>
					</ul>
					<p class="key-head">Bubbles</p>
					<ul>
						<li><svg class="mark" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><line class="k-merging" x1="1" y1="7" x2="21" y2="7" /></svg>Merging with each other</li>
						<li><svg class="mark" width="22" height="14" viewBox="0 0 22 14" aria-hidden="true"><line class="k-conflict" x1="1" y1="7" x2="21" y2="7" /></svg>Conflict: open it to ferge</li>
						<li><svg class="mark badge" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">{@render lockIcon()}</svg>Locked</li>
						<li><svg class="mark badge ferge-badge" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">{@render fergeIcon()}</svg>Ferge</li>
					</ul>
					<p class="key-hint">Right-click a bubble or the map for actions.</p>
				</div>
			</details>
		</div>

		{#if data}
			<section class="needs" class:clear={!need.length} class:narrow aria-label="Needs you" bind:offsetWidth={needsW} bind:offsetHeight={needsH}>
				{#if !need.length}
					<p class="all-clear"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7.5l2.5 2.5L11 4.5" /></svg>Nothing needs you</p>
				{:else}
					<details bind:open={needsOpen}>
						<summary><span>Needs you</span><span class="count">{need.length}</span></summary>
						<ul style="max-height:{Math.max(160, (narrow ? h * 0.5 : h - dockH - 130))}px">
							{#each need as n (n.key)}
								{@const s = spotOf(n)}
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions (hover only previews; the row's links and buttons act) -->
								<li
									onpointerenter={() => s && (spot = s)}
									onpointerleave={() => (spot = null)}
									onfocusin={() => s && (spot = s)}
									onfocusout={() => (spot = null)}
								>
									{#if n.kind === "conflict"}
										<Mark status="conflict" />
										<div class="what">
											<p><strong>{nameById(n.a)}</strong> and <strong>{nameById(n.b)}</strong> conflict</p>
											<div class="acts">
												<button class="small primary" onclick={() => onconflict?.(n.a, n.b)}>Ferge…</button>
												<button class="small" onclick={() => focusOn([n.a, n.b])}>Show</button>
											</div>
										</div>
									{:else if n.kind === "fork"}
										<Mark status={n.mark} />
										<div class="what" data-fork={n.fork}>
											<p><a href={looseHref?.(n.fork)}>{n.title}</a></p>
											<p class="why">{n.why}</p>
										</div>
									{:else if n.kind === "task"}
										<Mark status={n.mark} />
										<div class="what">
											<p><a href={taskHref?.(n.id)}>{n.title}</a></p>
											<p class="why">{n.why}</p>
										</div>
									{:else if n.kind === "ferge"}
										<Mark status="conflict" />
										<div class="what">
											<p><a href={hrefFor?.(n.bubble, "conflicts")}>{nameById(n.bubble)} holds a ferge's conflicts</a></p>
											<p class="why">{n.why}</p>
											<div class="acts"><button class="small" onclick={() => focusOn([n.bubble])}>Show</button></div>
										</div>
									{:else if n.kind === "page"}
										<Mark status={n.key === "n:memory" ? "review" : "failed"} />
										<div class="what">
											<p><a href={pageHref?.(n.tab)}>{n.title}</a></p>
											<p class="why">{n.why}</p>
										</div>
									{:else}
										<Mark status="failed" />
										<div class="what">
											<p><a href={hrefFor?.(n.bubble)}><span class="mono">{short(n.fork)}</span> in {nameById(n.bubble)}</a></p>
											<p class="why">{n.why}</p>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					</details>
				{/if}
			</section>
		{/if}
	{/if}

	{#if dock.length}
		<section class="dock" aria-label="Not in a bubble yet" style={narrow ? `bottom:${needsH + 24}px` : undefined} bind:offsetHeight={dockH}>
			{#each groups as g (g.status)}
				{@const open = !folded || openGroup === g.status}
				<div class="group" class:open data-group={g.status}>
					{#if folded && !demo}
						<button class="group-head" aria-expanded={open} onclick={() => (openGroup = open ? null : g.status)}>
							<Mark status={g.status} />{agentLabel(g.status)}<span class="n">{g.items.length}</span>
						</button>
					{:else}
						<span class="group-head">{agentLabel(g.status)}<span class="n">{g.items.length}</span></span>
					{/if}
					{#if open}
						<ul>
							{#each g.items as x (x.fork)}
								<li>
									<svelte:element this={chipHref(x) ? "a" : "span"} href={chipHref(x)} class="chip" class:person={x.person} data-fork={x.fork} title={x.title}>
										{#if x.person}
											<svg class="mark" width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><g class="person-icon">{@render personIcon()}</g></svg>
										{:else}
											<Mark status={x.status} />
										{/if}
										<span class="t">{x.title}</span>
										<span class="visually-hidden">: {x.person ? "a notagent's fork, " : ""}{agentLabel(x.status).toLowerCase()}</span>
									</svelte:element>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</section>
	{/if}

	{#if hoverNode && !demo}
		{@const n = hoverNode}
		<div class="card" id="map-card" style={cardStyle}>
			<div class="card-head">
				<strong>{nameOf(n)}</strong>
				{#if !n.b.visible}<span class="tag">Merging</span>{/if}
				{#if n.b.ferge}<span class="tag">Ferge</span>{/if}
				{#if n.b.locked}<span class="tag">Locked</span>{/if}
			</div>
			<p class="muted">{plural(n.members.length, "fork")}, {plural(n.files, "file")}</p>
			<ul>
				{#each n.members.slice(0, 6) as m}
					<li><Mark status={m.status} /><span class="mono">{short(m.name)}</span><span class="muted">{m.status === "rep" ? "representative" : m.status}</span></li>
				{/each}
				{#if n.members.length > 6}<li class="muted">and {n.members.length - 6} more</li>{/if}
			</ul>
			{#if n.files}
				{@const files = [...new Set(n.members.flatMap((m) => m.files))]}
				<div class="files">
					{#each files.slice(0, 5) as f}<code>{f}</code>{/each}
					{#if files.length > 5}<span class="muted">and {files.length - 5} more</span>{/if}
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
		--overlay: color-mix(in srgb, var(--raised) 94%, transparent);
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

	svg { display: block; touch-action: none; user-select: none; cursor: grab; }
	svg:active { cursor: grabbing; }
	.demo svg { cursor: default; }
	svg:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }

	.i-fill { fill: var(--ink-2); }
	.i-line { fill: none; stroke: var(--ink-2); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
	.person-icon .i-fill { fill: var(--ink-2); }
	.flyer { pointer-events: none; filter: drop-shadow(0 1px 2px rgb(15 24 33 / 0.3)); }

	/* Bubbles */
	.bubble { cursor: pointer; outline: none; }
	.bubble .film { transition: opacity 200ms ease-out; }
	.bubble .body { fill: url(#soap); }
	.bubble .rim { fill: none; stroke-width: 3; transition: stroke-width 150ms; }
	.bubble.hot .rim, .bubble:focus-visible .rim { stroke-width: 5; }
	.bubble:focus-visible .body { stroke: var(--focus); stroke-width: 2; stroke-dasharray: 3 4; }
	.bubble .glint { fill: none; stroke: rgb(255 255 255 / 0.9); stroke-width: 3; stroke-linecap: round; }
	.bubble.merging .rim { stroke-dasharray: 14 9; animation: swirl 1.4s linear infinite; }
	.bubble.merging .body { opacity: 0.6; }
	.bubble.locked .glint { opacity: 0.4; }
	.bubble.ferge .rim { stroke-dasharray: 3 5; stroke-linecap: round; stroke-width: 4; }
	.badge circle { fill: var(--paper); stroke: var(--ink-3); stroke-width: 1.5; }
	.ferge-badge circle { stroke: var(--working); }
	.ferge-badge .i-line { stroke: var(--working); stroke-width: 1.8; }
	.merging-line { stroke: var(--ink-3); stroke-width: 2; stroke-dasharray: 10 7; animation: swirl 1.4s linear infinite; vector-effect: non-scaling-stroke; }
	@keyframes swirl { to { stroke-dashoffset: -46; } }
	@media (prefers-reduced-motion: reduce) {
		.bubble.merging .rim, .merging-line { animation: none; }
	}

	/* What needs a person stands out; the rest steps back while it does. */
	.halo { fill: none; stroke: var(--conflict); stroke-width: 2; stroke-dasharray: 2 5; stroke-linecap: round; vector-effect: non-scaling-stroke; }
	.calming .bubble:not(.needs):not(.hot):not(:focus-visible) .film { opacity: 0.55; }
	.spotting .bubble:not(.lit) .film, .spotting .bubble:not(.lit) text { opacity: 0.3; }
	.spotting .conflict:not(.lit) { opacity: 0.3; }
	.bubble.lit .halo { stroke-width: 3; stroke-dasharray: none; }

	.ripple {
		fill: none;
		stroke-width: 3;
		transform-box: fill-box;
		transform-origin: center;
		animation: ripple 900ms ease-out forwards;
		pointer-events: none;
	}
	@keyframes ripple { from { opacity: 0.9; transform: scale(1); } to { opacity: 0; transform: scale(1.35); } }

	text { text-anchor: middle; fill: var(--ink-2); pointer-events: none; }
	text.id { font-size: 12px; font-weight: 600; fill: var(--ink); }
	text.sub { font-size: 11px; fill: var(--ink-2); }
	.merging text.sub { font-style: italic; }
	.needs text.sub { fill: var(--conflict); font-weight: 600; }

	.conflict { cursor: pointer; outline: none; }
	.conflict .hit { stroke: transparent; stroke-width: 22; vector-effect: non-scaling-stroke; }
	.conflict .dash { stroke: var(--conflict); stroke-width: 2.5; stroke-dasharray: 7 5; vector-effect: non-scaling-stroke; }
	.conflict rect { fill: var(--conflict); stroke: var(--paper); stroke-width: 2; }
	.conflict .bang { stroke: #fff; stroke-width: 2.6; stroke-linecap: round; fill: none; }
	.conflict:hover .dash, .conflict:focus-visible .dash, .conflict.lit .dash { stroke-width: 4; }
	.conflict:focus-visible rect { stroke: var(--focus); stroke-width: 3; }

	/* Overlays */
	.loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--ink-2); }
	.empty { position: absolute; left: 1rem; top: 4.5rem; max-width: 28rem; padding: 1.25rem; background: var(--overlay); border: 1px solid var(--line); border-radius: var(--r-md); }
	.empty-title { font-size: 1.25rem; font-weight: 700; margin-bottom: 0.35rem; }
	.empty p:not(.empty-title) { color: var(--ink-2); margin-bottom: 1rem; }
	.stale {
		position: absolute;
		left: 50%;
		translate: -50% 0;
		padding: 0.4rem 0.8rem;
		border-radius: var(--r-sm);
		background: var(--harbor);
		color: var(--on-harbor);
		font-size: 0.8125rem;
		z-index: 6;
	}

	.bar { position: absolute; left: 1rem; top: 1rem; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem; max-width: calc(100% - 2rem); z-index: 4; pointer-events: none; }
	.bar > * { pointer-events: auto; }
	.zoom { display: flex; gap: 2px; }
	.zoom button { padding: 0.3rem 0.6rem; min-width: 2rem; justify-content: center; background: var(--overlay); }
	.zoom svg path { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
	.key { position: relative; }
	.key summary {
		list-style: none;
		cursor: pointer;
		padding: 0.3rem 0.7rem;
		font-size: 0.875rem;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--overlay);
	}
	.key summary::-webkit-details-marker { display: none; }
	.key summary:hover { border-color: var(--ink-3); }
	.key summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
	.key[open] summary { background: var(--raised); }
	.key-body {
		position: absolute;
		top: calc(100% + 0.35rem);
		left: 0;
		width: 17rem;
		padding: 0.75rem 0.9rem;
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		box-shadow: 0 10px 30px rgb(15 24 33 / 0.16);
		font-size: 0.8125rem;
	}
	.key-head { font-weight: 600; margin: 0.6rem 0 0.3rem; }
	.key-head:first-child { margin-top: 0; }
	.key ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25rem; color: var(--ink-2); }
	.key li { display: flex; align-items: center; gap: 0.5rem; }
	.key-hint { margin-top: 0.7rem; padding-top: 0.6rem; border-top: 1px solid var(--line-2); color: var(--ink-2); }
	.k-merging { stroke: var(--ink-3); stroke-width: 2; stroke-dasharray: 5 3; }
	.k-conflict { stroke: var(--conflict); stroke-width: 2.5; stroke-dasharray: 5 3; }
	.mark.badge { border-radius: 50%; }

	/* Needs you */
	.needs { position: absolute; right: 1rem; top: 1rem; width: 21rem; max-width: calc(100% - 2rem); z-index: 5; }
	.needs.clear { width: auto; }
	.all-clear {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		float: right;
		padding: 0.3rem 0.75rem 0.3rem 0.6rem;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--overlay);
		font-size: 0.8125rem;
		color: var(--ink-2);
	}
	.all-clear path { fill: none; stroke: var(--merged); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
	.needs details {
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		box-shadow: 0 10px 30px rgb(15 24 33 / 0.14);
		overflow: hidden;
	}
	.needs summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 0.9rem;
		font-weight: 700;
		cursor: pointer;
		list-style: none;
	}
	.needs summary::-webkit-details-marker { display: none; }
	.needs summary::after { content: ""; margin-left: auto; width: 0.45rem; height: 0.45rem; border: solid var(--ink-3); border-width: 0 1.5px 1.5px 0; rotate: 45deg; translate: 0 -2px; transition: rotate 150ms ease-out; }
	.needs details[open] summary::after { rotate: -135deg; translate: 0 2px; }
	.needs summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	.count { min-width: 1.5rem; padding: 0 0.45rem; border-radius: 999px; background: var(--conflict); color: #fff; font-size: 0.75rem; text-align: center; font-variant-numeric: tabular-nums; }
	.needs ul { list-style: none; margin: 0; padding: 0 0 0.25rem; overflow-y: auto; border-top: 1px solid var(--line-2); }
	.needs li { display: flex; gap: 0.6rem; padding: 0.65rem 0.9rem; font-size: 0.875rem; }
	.needs li + li { border-top: 1px solid var(--line-2); }
	.needs li:hover { background: color-mix(in srgb, var(--conflict) 5%, transparent); }
	.needs li > :global(.mark) { margin-top: 0.2rem; }
	.what { min-width: 0; flex: 1; }
	.what p { overflow-wrap: anywhere; }
	.what a { color: var(--ink); font-weight: 600; text-decoration: none; }
	.what a:hover { text-decoration: underline; text-underline-offset: 2px; }
	.why { color: var(--ink-2); font-size: 0.8125rem; margin-top: 0.1rem; }
	.acts { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
	.small { padding: 0.2rem 0.6rem; font-size: 0.8125rem; }

	/* Dock: forks not in a bubble yet */
	.dock {
		position: absolute;
		left: 1rem;
		right: 1rem;
		bottom: 1rem;
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 0.5rem 1.25rem;
		max-height: 45%;
		overflow-y: auto;
		pointer-events: none;
		z-index: 4;
	}
	.group { display: flex; flex-direction: column; gap: 0.3rem; pointer-events: auto; min-width: 0; }
	.group-head {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		align-self: flex-start;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--ink-2);
	}
	button.group-head { padding: 0.25rem 0.6rem; background: var(--overlay); font-size: 0.8125rem; }
	.group-head .n { font-variant-numeric: tabular-nums; color: var(--ink-3); font-weight: 500; }
	button.group-head .n { color: var(--ink-2); }
	.group ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		max-width: 15rem;
		padding: 0.3rem 0.75rem 0.3rem 0.55rem;
		border: 1.5px solid var(--working);
		border-radius: 999px;
		background: var(--raised);
		color: var(--ink);
		font-size: 0.8125rem;
		text-decoration: none;
		box-shadow: 0 2px 4px rgb(15 24 33 / 0.08);
	}
	.chip.person { border-color: var(--pending); border-style: dashed; }
	.group:not([data-group="running"]) .chip:not(.person) { border-color: var(--line); }
	a.chip:hover { border-width: 1.5px; box-shadow: 0 3px 10px rgb(15 24 33 / 0.14); }
	a.chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
	.chip .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	/* Hover card */
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
		z-index: 6;
	}
	.card-head { display: flex; align-items: center; gap: 0.5rem; }
	.card-head strong { font-size: 0.875rem; }
	.tag { font-size: 0.6875rem; padding: 0.05rem 0.4rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
	.card ul { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.2rem; }
	.card li { display: flex; align-items: center; gap: 0.5rem; }
	.card .files { margin-top: 0.6rem; padding-top: 0.5rem; border-top: 1px solid var(--line-2); display: grid; gap: 0.1rem; }
	.card code { font-size: 0.75rem; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.needs.narrow { top: auto; bottom: 1rem; left: 1rem; right: 1rem; width: auto; }
	.needs.narrow.clear { left: auto; }
	@media (max-width: 768px) {
		.card { display: none; }
		}
</style>
