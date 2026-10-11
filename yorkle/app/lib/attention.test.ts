import { expect, test } from "vitest";
import { docked, needs } from "./attention";
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

	const n = needs(d);
	expect(n.map((x) => x.key)).toEqual(["c:r-demo-f-3fa1c09e|r-demo-f-5c08aa71", "f:review", "f:ci-red", "f:handed", "t:t1", `m:${d.bubbles[0].members[1].name}`]);
	expect(n.find((x) => x.key === "f:handed")).toMatchObject({ why: "CI failed; a person takes over" });

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
