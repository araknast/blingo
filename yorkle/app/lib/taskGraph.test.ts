import { expect, test } from "vitest";
import { KINDS, kindOf, lineage, taskGraph } from "./taskGraph";
import type { Task } from "./types";

const t = (id: string, deps: string[] = [], created = 0): Task => ({ id, title: id, description: "", kind: "agent", status: "open", bubble: null, fork: null, deps, explanation: null, superagent: null, created, finished: null, ready: true, skills: null, role: "agent" });

test("each task sits a row below its deepest dep, with an edge for every dep it can see", () => {
	const { nodes, edges } = taskGraph([t("a"), t("z", [], 1), t("b", ["a"]), t("c", ["b", "a", "missing"]), t("d", ["z"]), t("loop", ["loop"])]);
	const at = (id: string) => nodes.find((n) => n.task.id === id)!;
	expect(["a", "z", "loop"].map((id) => at(id).y)).toEqual([0, 0, 0]);
	expect(at("b").y).toBeGreaterThan(0);
	expect(at("c").y).toBeGreaterThan(at("b").y);
	expect(at("d").y).toBe(at("b").y);
	expect(at("d").x).toBeGreaterThan(at("b").x); // its dep z sits right of a
	expect(edges).toEqual([{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "z", to: "d" }]);
	expect([at("c").hidden, at("loop").hidden]).toEqual([1, 0]);
	expect(lineage(edges, "b")).toEqual(new Set(["b", "a", "c"]));
});

test("a dependency cycle still lays out", () => {
	expect(taskGraph([t("p", ["q"]), t("q", ["p"])]).nodes).toHaveLength(2);
});

test("every task falls under one filter chip", () => {
	const ids = KINDS.map((k) => k.id) as string[];
	for (const status of ["awaiting-approval", "open", "in-progress", "completed", "failed"] as const)
		for (const ready of [true, false])
			for (const kind of ["agent", "notagent"] as const)
				for (const fork of [null, "f", "shut"]) expect(ids).toContain(kindOf({ ...t("x"), status, ready, kind, fork }, ["shut"]));
	expect(kindOf({ ...t("x"), status: "open", ready: false }, [])).toBe("waiting");
	expect(kindOf({ ...t("x"), kind: "notagent" }, [])).toBe("ready");
	expect(kindOf({ ...t("x"), fork: "shut", status: "failed" }, ["shut"])).toBe("cancelled");
});
