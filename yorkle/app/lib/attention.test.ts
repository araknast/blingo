import { expect, test } from "vitest";
import { docked, needs, needsByTab } from "./attention";
import { demoSteps } from "./demo";
import type { LooseFork, RepoState } from "./types";

const loose = (fork: string, o: Partial<LooseFork>): LooseFork => ({ fork, kind: "notagent", pushes: 1, pushable: true, reason: null, ci: null, ciLog: null, reviewAuto: null, reviewManual: null, reviewNote: null, ...o });

test("conflicts, stuck forks, failed tasks and unapplied series need a person; work in progress doesn't", () => {
	const d: RepoState = structuredClone(demoSteps[4]);
	d.loose = [
		loose("in-ci", { kind: "agent", ci: "running" }),
		loose("fixer", { kind: "agent", ci: "failed" }), // its fixer agent's job
		loose("review", { kind: "agent", reviewManual: "pending" }),
		loose("ci-red", { ci: "failed" }),
		loose("handed", { reason: "CI failed; a person takes over" }),
		loose("unpushed", { pushes: 0 }),
	];
	d.tasks = [{ id: "t1", title: "Fix the parser", description: "", kind: "agent", status: "failed", bubble: null, fork: null, deps: [], explanation: null, superagent: null, created: 0, finished: 0, ready: true, skills: null, role: "agent" }];
	d.bubbles[0].members[1].status = "failed";
	d.settings.hasKey = true;

	const n = needs(d);
	expect(n.map((x) => x.key)).toEqual(["c:r-demo-f-3fa1c09e|r-demo-f-5c08aa71", "f:review", "f:ci-red", "f:handed", "t:t1", `m:${d.bubbles[0].members[1].name}`]);
	expect(n.find((x) => x.key === "f:handed")).toMatchObject({ why: "CI failed; a person takes over" });

	// A task awaiting approval needs you; a review is drawn as one, and a fork with no task goes by its agent's prompt.
	d.tasks.push({ ...d.tasks[0], id: "t2", status: "awaiting-approval" });
	d.agents.push({ fork: "review", prompt: "Add a health check", started: 0, status: "loose", finished: null, log: null });
	const m = needs(d);
	expect(m.find((x) => x.key === "t:t2")).toMatchObject({ why: "Waiting for your approval", mark: "approval" });
	expect(m.find((x) => x.key === "f:review")).toMatchObject({ title: "Add a health check", mark: "review" });
	expect(needsByTab(d).tasks).toBe(2);
	d.tasks.pop();
	d.agents.pop();

	// Ready to place only when placement is manual.
	expect(needs({ ...d, settings: { ...d.settings, autoPlaceNotagents: false } }).some((x) => x.key === "f:unpushed")).toBe(false);
	d.loose.push(loose("ready", {}));
	expect(needs({ ...d, settings: { ...d.settings, autoPlaceNotagents: false } }).find((x) => x.key === "f:ready")).toMatchObject({ why: "Ready to place" });

	// The dock holds everything else that isn't placed, and nothing that needs a person.
	const dock = docked(d).map((x) => x.fork);
	expect(dock).toEqual(expect.arrayContaining(["r-demo-f-e2b8f6c1", "r-demo-f-b1d7c2e8", "in-ci", "fixer", "unpushed"]));
	expect(dock).not.toContain("review");
	expect(dock).not.toContain("handed");
});

test("the repository's setup, a failed deployment and new notes from agents need a person too", () => {
	const d: RepoState = structuredClone(demoSteps[0]);
	const pages = (x: RepoState) => needs(x).filter((n) => n.kind === "page").map((n) => n.key);
	expect(pages(d)).toEqual([]); // no key: notagents still work
	d.settings.hasKey = true;
	d.settings.keyProvider = "anthropic";
	d.settings.provider = "openrouter";
	expect(pages(d)).toEqual(["k:provider"]);
	expect(needs(d).find((n) => n.key === "k:provider")).toMatchObject({ tab: "settings" });
	d.settings.keyProvider = "openrouter";
	const run = (id: string, name: string, status: "running" | "succeeded" | "failed", started: number) => ({ id, name, bubble: "b", head: "h", status, started, finished: null, log: null, by: "me" });
	d.deploys = [run("1", "prod", "failed", 1), run("2", "prod", "succeeded", 2), run("3", "staging", "failed", 3)];
	expect(pages(d)).toEqual(["d:3"]); // prod ran again and passed
	d.memory = [
		{ id: "m1", text: "a", author: "kofi", created: 10 },
		{ id: "m2", text: "b", author: "r-demo-f-1234", created: 10 },
		{ id: "m3", text: "c", author: "r-demo-s-1234", created: 3 },
	];
	expect(pages(d)).toEqual(["d:3"]); // new notes are news (a grey badge), not something to act on
});

test("with auto-ferge and ferge agents, conflicts aren't a person's, but a ferge whose agent failed is", () => {
	const d: RepoState = structuredClone(demoSteps[4]);
	expect(needs(d).some((n) => n.kind === "conflict")).toBe(true);
	d.settings.autoFerge = true;
	expect(needs(d).some((n) => n.kind === "conflict")).toBe(true); // markers still need fixing by hand
	d.settings.fergeAgents = true;
	expect(needs(d).some((n) => n.kind === "conflict")).toBe(false);
	d.bubbles[1].ferge = d.bubbles[1].locked = true;
	d.tasks = [{ id: "t1", title: "x", description: "", kind: "agent", status: "in-progress", bubble: d.bubbles[1].id, fork: null, deps: [], explanation: null, superagent: null, created: 0, finished: 0, ready: true, skills: null, role: "ferge" }];
	expect(needs(d).some((n) => n.kind === "ferge")).toBe(false);
	d.tasks[0].status = "failed";
	expect(needs(d).find((n) => n.kind === "ferge")).toMatchObject({ bubble: d.bubbles[1].id });
});

test("every item belongs to a tab, and an open ferge waits on the bubbles tab", () => {
	const d: RepoState = structuredClone(demoSteps[4]);
	d.bubbles[1].ferge = d.bubbles[1].locked = true;
	d.bubbles[0].members[1].status = "failed";
	d.loose = [loose("review", { kind: "agent", reviewManual: "pending" })];
	d.tasks = [{ id: "t1", title: "x", description: "", kind: "agent", status: "failed", bubble: null, fork: null, deps: [], explanation: null, superagent: null, created: 0, finished: 0, ready: true, skills: null, role: "agent" }];
	expect(needs(d).find((n) => n.kind === "ferge")).toMatchObject({ tab: "bubbles", bubble: d.bubbles[1].id });
	// The conflict, the failed member and the ferge; the review; the task.
	expect(needsByTab(d)).toEqual({ bubbles: 3, agents: 1, tasks: 1 });
	// While a ferge agent works on it the locked bubble isn't a person's; once it failed, it is again.
	d.tasks.push({ ...d.tasks[0], id: "t2", status: "in-progress", role: "ferge", bubble: d.bubbles[1].id });
	expect(needs(d).find((n) => n.kind === "ferge")).toBeUndefined();
	// Done, with its fix queued in the bubble: still the agent's until it's applied (and unlocks).
	d.tasks[1] = { ...d.tasks[1], status: "completed", fork: "fix" };
	d.bubbles[1].members.push({ name: "fix", bubble: d.bubbles[1].id, status: "pending", files: [] });
	expect(needs(d).find((n) => n.kind === "ferge")).toBeUndefined();
	d.tasks[1].status = "failed";
	expect(needs(d).find((n) => n.kind === "ferge")).toBeDefined();
});
