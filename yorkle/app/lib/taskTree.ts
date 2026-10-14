import type { Task } from "./types";

export type TaskNode = { task: Task; children: TaskNode[]; also: number };

// Open tasks as a tree: each sits under the first open task it depends on (`also` counts its other open
// deps), so a plan reads top-down in the order its work lands. Completed tasks drop out, which lifts
// their dependents to the top.
export function taskTree(tasks: Task[]): TaskNode[] {
	const open = new Map(tasks.filter((t) => t.status !== "completed").map((t) => [t.id, t]));
	const nodes = new Map([...open.values()].map((t) => [t.id, { task: t, children: [] as TaskNode[], also: 0 }]));
	const roots: TaskNode[] = [];
	for (const n of [...nodes.values()].sort((a, b) => a.task.created - b.task.created)) {
		const deps = n.task.deps.filter((d) => open.has(d) && d !== n.task.id);
		n.also = Math.max(0, deps.length - 1);
		(deps.length ? nodes.get(deps[0])!.children : roots).push(n);
	}
	return roots;
}
