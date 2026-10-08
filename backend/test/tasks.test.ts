import { expect, test } from "vitest";
import { explanation, ready, renameOwed, validatePlan, type ForkState, type TaskState } from "../src/tasks";

const t = (id: string, status: TaskState["status"], deps: string[] = [], fork: string | null = null, bubble: string | null = null): TaskState => ({
	id,
	status,
	deps,
	fork,
	bubble,
});
const f = (name: string, bubble: string, status: string): ForkState => ({ name, bubble, status });
const vis = (...ids: string[]) => ids.map((id) => ({ id, visible: true }));

test("tasks without deps start from their chosen bubble, else the fallback", () => {
	const r = ready([t("a", "open", [], null, "B"), t("b", "open", [], null, "gone"), t("c", "in-progress")], [], vis("A", "B"), [], "A");
	expect([...r]).toEqual([["a", "B"], ["b", "A"]]);
	expect(ready([t("a", "open")], [], [], [], null).get("a")).toBeNull(); // empty repo → base
});

test("a dependent task waits until one bubble holds every dep fully merged", () => {
	const deps = [t("d1", "completed", [], "f1"), t("d2", "completed", [], "f2"), t("x", "open", ["d1", "d2"])];
	// split across bubbles
	expect(ready(deps, [f("A", "A", "rep"), f("f1", "A", "merged"), f("B", "B", "rep"), f("f2", "B", "merged")], vis("A", "B"), [], "A").has("x")).toBe(false);
	// same bubble but one dep still pending
	expect(ready(deps, [f("A", "A", "rep"), f("f1", "A", "merged"), f("f2", "A", "pending")], vis("A"), [], "A").has("x")).toBe(false);
	// absorbed: members read merged but the absorbed rep is still pending
	expect(ready(deps, [f("A", "A", "rep"), f("f1", "A", "merged"), f("f2", "A", "merged"), f("B", "A", "pending")], vis("A"), [], "A").has("x")).toBe(false);
	// a dep in conflict never counts
	expect(ready(deps, [f("A", "A", "rep"), f("f1", "A", "merged"), f("f2", "A", "conflict")], vis("A"), [], "A").has("x")).toBe(false);
	// hidden (mid-merge)
	expect(ready(deps, [f("A", "A", "rep"), f("f1", "A", "merged"), f("f2", "A", "merged")], [{ id: "A", visible: false }], [], "A").has("x")).toBe(false);
	// all there
	const all = [f("A", "A", "rep"), f("f1", "A", "merged"), f("f2", "A", "rep")];
	expect(ready(deps, all, vis("A"), [], "Z").get("x")).toBe("A");
	// …but owed a ferge's locked bubble
	expect(ready(deps, all, vis("A", "L"), [{ locked: "L", into: "A" }], "A").has("x")).toBe(false);
	// a dep not yet completed
	expect(ready([t("d1", "in-progress", [], "f1"), t("x", "open", ["d1"])], [f("f1", "A", "merged")], vis("A"), [], "A").has("x")).toBe(false);
});

test("ferge debt is paid when the locked bubble reaches the bubble it owes, either way", () => {
	const owed = [{ locked: "L", into: "A" }];
	expect(renameOwed(owed, "L", "A")).toEqual([]); // L absorbed into A
	expect(renameOwed(owed, "A", "L")).toEqual([]); // A absorbed into L
	expect(renameOwed(owed, "A", "C")).toEqual([{ locked: "L", into: "C" }]); // A moved on; still owed
	expect(renameOwed(owed, "L", "C")).toEqual([{ locked: "C", into: "A" }]); // L's code is in C now
	expect(renameOwed([{ locked: "L", into: "A" }, { locked: "M", into: "A" }], "M", "L")).toEqual([{ locked: "L", into: "A" }]);
});

test("validatePlan checks keys, kinds, deps and cycles", () => {
	const ok = validatePlan([
		{ key: "a", description: "do a", kind: "agent" },
		{ key: "b", description: "do b", kind: "notagent", deps: ["a", "a"] },
	]);
	expect(ok).toEqual({
		items: [
			{ key: "a", description: "do a", kind: "agent", deps: [] },
			{ key: "b", description: "do b", kind: "notagent", deps: ["a"] },
		],
	});
	expect(validatePlan([])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", description: "x", kind: "robot" }])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", description: "", kind: "agent" }])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", description: "x", kind: "agent", deps: ["z"] }])).toHaveProperty("error");
	expect(
		validatePlan([
			{ key: "a", description: "x", kind: "agent", deps: ["b"] },
			{ key: "b", description: "y", kind: "agent", deps: ["a"] },
		]),
	).toEqual({ error: "dependency cycle among a, b" });
});

test("explanation stops at the fork's starting commit", () => {
	const log = [
		{ hash: "3", message: "fix tests\n" },
		{ hash: "2", message: "add feature" },
		{ hash: "1", message: "base" },
	];
	expect(explanation(log, "1")).toBe("fix tests\n\nadd feature");
	expect(explanation(log, "")).toBe("fix tests\n\nadd feature\n\nbase");
});
