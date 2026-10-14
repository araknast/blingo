import type { Task } from "./types";

export type TaskNode = { task: Task; children: TaskNode[]; also: number };

// Tasks as a tree: each sits under the first of its deps that's in `tasks` (`also` counts its others
// there), so a plan reads top-down in the order its work lands. A dep left out (filtered, or gone) lifts
// its dependents to the top.
export function taskTree(tasks: Task[]): TaskNode[] {
	const nodes = new Map(tasks.map((t) => [t.id, { task: t, children: [] as TaskNode[], also: 0 }]));
	const roots: TaskNode[] = [];
	for (const n of [...nodes.values()].sort((a, b) => a.task.created - b.task.created)) {
		const deps = n.task.deps.filter((d) => nodes.has(d) && d !== n.task.id);
		n.also = Math.max(0, deps.length - 1);
		(deps.length ? nodes.get(deps[0])!.children : roots).push(n);
	}
	return roots;
}
