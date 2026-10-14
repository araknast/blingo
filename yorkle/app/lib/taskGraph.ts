import type { Task } from "./types";

export const NODE_W = 208, NODE_H = 60, GAP_X = 20, GAP_Y = 56;

export type GraphNode = { task: Task; x: number; y: number; hidden: number };
export type GraphEdge = { from: string; to: string };

// Tasks as layers of what waits on what: each task sits a row below its deepest dep in `tasks`, and each
// row is ordered by where its deps sit, so a plan reads top-down in the order its work lands. Every dep in
// `tasks` is an edge; `hidden` counts the others (filtered out, or gone). `x` is a node's centre, `y` its top.
// ponytail: an edge spanning rows can pass behind cards; add a dummy node per row it crosses if that confuses.
export function taskGraph(tasks: Task[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const all = (t: Task) => [...new Set(t.deps)].filter((d) => d !== t.id);
	const deps = (t: Task) => all(t).filter((d) => byId.has(d));
	const layer = new Map<string, number>();
	const seen = new Set<string>();
	const depth = (t: Task): number => {
		if (layer.has(t.id)) return layer.get(t.id)!;
		if (seen.has(t.id)) return 0; // a cycle
		seen.add(t.id);
		const l = Math.max(-1, ...deps(t).map((d) => depth(byId.get(d)!))) + 1;
		layer.set(t.id, l);
		return l;
	};
	const rows: Task[][] = [];
	for (const t of [...tasks].sort((a, b) => a.created - b.created)) (rows[depth(t)] ??= []).push(t);

	const x = new Map<string, number>();
	const nodes: GraphNode[] = [];
	rows.forEach((row, l) => {
		const at = (t: Task) => {
			const xs = deps(t).map((d) => x.get(d) ?? 0);
			return xs.length ? xs.reduce((a, b) => a + b) / xs.length : 0;
		};
		if (l) row.sort((a, b) => at(a) - at(b)); // stable: ties keep creation order
		row.forEach((t, i) => {
			x.set(t.id, (i - (row.length - 1) / 2) * (NODE_W + GAP_X));
			nodes.push({ task: t, x: x.get(t.id)!, y: l * (NODE_H + GAP_Y), hidden: all(t).length - deps(t).length });
		});
	});
	return { nodes, edges: tasks.flatMap((t) => deps(t).map((d) => ({ from: d, to: t.id }))) };
}

// A task, everything it waits on (transitively), and everything that waits on it.
export function lineage(edges: GraphEdge[], id: string): Set<string> {
	const seen = new Set([id]);
	for (const [next, back] of [["from", "to"], ["to", "from"]] as const) {
		const stack = [id];
		while (stack.length) {
			const c = stack.pop()!;
			for (const e of edges) if (e[back] === c && !seen.has(e[next])) (seen.add(e[next]), stack.push(e[next]));
		}
	}
	return seen;
}
