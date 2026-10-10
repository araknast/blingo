import { expect, test } from "vitest";
import { explanation, fixPrompt, ready, renameOwed, retryNote, shortTitle, validatePlan, type ForkState, type TaskState } from "../src/tasks";

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

test("a task awaiting approval never starts", () => {
	expect(ready([t("a", "awaiting-approval")], [], vis("A"), [], "A").size).toBe(0);
});

test("ferge debt is paid when the locked bubble reaches the bubble it owes, either way", () => {
	const owed = [{ locked: "L", into: "A" }];
	expect(renameOwed(owed, "L", "A")).toEqual([]); // L absorbed into A
	expect(renameOwed(owed, "A", "L")).toEqual([]); // A absorbed into L
	expect(renameOwed(owed, "A", "C")).toEqual([{ locked: "L", into: "C" }]); // A moved on; still owed
	expect(renameOwed(owed, "L", "C")).toEqual([{ locked: "C", into: "A" }]); // L's code is in C now
	expect(renameOwed([{ locked: "L", into: "A" }, { locked: "M", into: "A" }], "M", "L")).toEqual([{ locked: "L", into: "A" }]);
});

test("validatePlan checks keys, titles, kinds, deps and cycles", () => {
	const ok = validatePlan([
		{ key: "a", title: "A", description: "do a", kind: "agent" },
		{ key: "b", title: "B", description: "do b", kind: "notagent", deps: ["a", "a"] },
	]);
	expect(ok).toEqual({
		items: [
			{ key: "a", title: "A", description: "do a", kind: "agent", deps: [] },
			{ key: "b", title: "B", description: "do b", kind: "notagent", deps: ["a"] },
		],
	});
	expect(validatePlan([])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", title: "A", description: "x", kind: "robot" }])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", title: "A", description: "", kind: "agent" }])).toHaveProperty("error");
	expect(validatePlan([{ key: "a", description: "x", kind: "agent" }])).toHaveProperty("error"); // no title
	expect(validatePlan([{ key: "a", title: "A", description: "x", kind: "agent", deps: ["z"] }])).toHaveProperty("error");
	expect(
		validatePlan([
			{ key: "a", title: "A", description: "x", kind: "agent", deps: ["b"] },
			{ key: "b", title: "B", description: "y", kind: "agent", deps: ["a"] },
		]),
	).toEqual({ error: "dependency cycle among a, b" });
	// a long title is shortened, not rejected
	const long = validatePlan([{ key: "a", title: "word ".repeat(30), description: "x", kind: "agent" }]);
	expect("items" in long && long.items[0].title.length).toBeLessThanOrEqual(60);
});

test("shortTitle takes the first line and cuts long ones at a word", () => {
	expect(shortTitle("Fix login\n\nmore detail")).toBe("Fix login");
	expect(shortTitle("\n# Add dark mode\nbody")).toBe("Add dark mode");
	const t = shortTitle("Add a dark mode toggle to the settings page and remember the choice per user");
	expect(t).toBe("Add a dark mode toggle to the settings page and remember…");
	expect(t.length).toBeLessThanOrEqual(60);
	expect(shortTitle("x".repeat(100)).length).toBe(60); // no space: hard cut
	expect(shortTitle("")).toBe("");
});

test("explanation reads a patch series' commit messages, newest first", () => {
	const mbox = `From 1111111111111111111111111111111111111111 Mon Sep 17 00:00:00 2001
From: Alice <alice@example.com>
Date: Sat, 10 Oct 2026 06:00:00 +0000
Subject: [PATCH 1/2] add feature

Why it was added.
---
 a.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/a.txt b/a.txt
--
2.47.0

From 2222222222222222222222222222222222222222 Mon Sep 17 00:00:00 2001
From: Alice <alice@example.com>
Date: Sat, 10 Oct 2026 06:01:00 +0000
Subject: [PATCH 2/2] =?UTF-8?q?fix=20caf=C3=A9?= tests, with a subject long
 enough to be folded

---
 b.txt | 1 +
`;
	expect(explanation(mbox)).toBe("fix café tests, with a subject long enough to be folded\n\nadd feature\n\nWhy it was added.");
	expect(explanation("")).toBe("");
});

test("a fixer's prompt carries the task, what failed, the CI output and review comments", () => {
	const p = fixPrompt({ title: "Add x", description: "Make x.txt", failed: ["ci"], command: "npm test", log: "1 failing", review: null });
	expect(p).toContain("# Fix: Add x");
	expect(p).toContain("ci failed");
	expect(p).toContain("Make x.txt");
	expect(p).toContain("1 failing");
	expect(p).not.toContain("Review comments");
	expect(fixPrompt({ title: "t", description: "d", failed: ["automatic review"], command: "", log: null, review: "Automatic review: no" })).toContain("## Review comments");
});

test("a retry's note points at the earlier run and says why it failed, when that's known", () => {
	const p = retryNote({ file: "/t/previous.jsonl", status: "failed", reason: "not placed: x", log: "boom" });
	expect(p).toContain("/t/previous.jsonl");
	expect(p).toContain(`"failed": not placed: x`);
	expect(p).toContain("boom");
	expect(retryNote({ file: "f", status: "lost" })).not.toContain("Its log");
});

test("a plan's skills must be among the repository's; omitted = all", () => {
	const item = (skills?: unknown) => [{ key: "a", title: "t", description: "d", kind: "agent", deps: [], skills }];
	expect(validatePlan(item(["x"]), ["x", "y"])).toMatchObject({ items: [{ skills: ["x"] }] });
	expect(validatePlan(item([]), ["x"])).toMatchObject({ items: [{ skills: [] }] });
	expect(validatePlan(item(["z"]), ["x"])).toHaveProperty("error");
	expect((validatePlan(item(), ["x"]) as { items: object[] }).items[0]).not.toHaveProperty("skills");
});
