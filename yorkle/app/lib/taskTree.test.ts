import { expect, test } from "vitest";
import { taskTree } from "./taskTree";
import type { Task } from "./types";

const t = (id: string, deps: string[] = [], status: Task["status"] = "open"): Task => ({ id, title: id, description: "", kind: "agent", status, bubble: null, fork: null, deps, explanation: null, superagent: null, created: 0, finished: null, ready: true, skills: null, role: "agent" });
const shape = (ns: ReturnType<typeof taskTree>): unknown => ns.map((n) => (n.children.length ? { [n.task.id]: shape(n.children) } : n.task.id));

test("tasks nest under the first given task they depend on; a missing dep lifts them to the top", () => {
	const tasks = [t("a"), t("b", ["a"]), t("c", ["b", "a"]), t("done", [], "completed"), t("d", ["done"]), t("e", ["missing"])];
	const tree = taskTree(tasks);
	expect(shape(tree)).toEqual([{ a: [{ b: ["c"] }] }, { done: ["d"] }, "e"]);
	expect(tree[0].children[0].children[0].also).toBe(1);
	expect(shape(taskTree(tasks.filter((x) => x.status !== "completed")))).toEqual([{ a: [{ b: ["c"] }] }, "d", "e"]);
});
