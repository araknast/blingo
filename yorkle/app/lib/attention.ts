import type { AgentRun, RepoState } from "./types";
import { agentLabel, allRuns, active, short } from "./util";

// What the map asks a person to act on. Clean merges and agents at work are background; these aren't.
export type Need =
	| { kind: "conflict"; key: string; a: string; b: string }
	| { kind: "fork"; key: string; fork: string; title: string; why: string }
	| { kind: "task"; key: string; id: string; title: string; why: string }
	| { kind: "member"; key: string; bubble: string; fork: string; why: string };

export function needs(d: RepoState): Need[] {
	const out: Need[] = d.conflicts.map(([a, b]) => ({ kind: "conflict", key: `c:${a}|${b}`, a, b }));
	const titleOf = new Map(d.tasks.filter((t) => t.fork).map((t) => [t.fork!, t.title]));
	for (const l of d.loose) {
		const why = looseWhy(l, d.settings.autoPlaceNotagents);
		if (why) out.push({ kind: "fork", key: `f:${l.fork}`, fork: l.fork, title: titleOf.get(l.fork) ?? short(l.fork), why });
	}
	const runOf = new Map(d.agents.map((a) => [a.fork, a]));
	for (const t of d.tasks) {
		if (t.status !== "failed") continue;
		const run = t.fork ? runOf.get(t.fork) : undefined;
		out.push({ kind: "task", key: `t:${t.id}`, id: t.id, title: t.title, why: run ? `Agent ${agentLabel(run.status).toLowerCase()}` : "Task failed" });
	}
	for (const b of d.bubbles)
		for (const m of b.members)
			if (m.status === "failed") out.push({ kind: "member", key: `m:${m.name}`, bubble: b.id, fork: m.name, why: "Its changes didn't apply" });
	return out;
}

// A loose fork needs a person when a review waits on them, or when it's theirs (a notagent, or an agent's
// fork handed over) and something stopped it. An agent's own failed CI is its fixer's job, not theirs.
function looseWhy(l: RepoState["loose"][number], autoPlace: boolean): string | null {
	if (l.reviewManual === "pending") return "Waiting for your review";
	if (l.kind !== "notagent") return null;
	if (l.reason) return l.reason;
	if (l.ci === "failed") return "CI failed";
	if (l.reviewAuto === "rejected" || l.reviewManual === "rejected") return "Review rejected";
	if (!autoPlace && l.pushes > 0 && l.ci !== "running" && l.reviewAuto !== "pending") return "Ready to place";
	return null;
}

// Every fork not in a bubble yet, by what it's doing; the map's dock. Forks that need a person are left
// to `needs`.
export type Docked = { fork: string; title: string; person: boolean; status: string };
export function docked(d: RepoState, need: Need[] = needs(d)): Docked[] {
	const skip = new Set(need.flatMap((n) => (n.kind === "fork" ? [n.fork] : [])));
	const runs: AgentRun[] = allRuns(d).filter(active);
	const seen = new Set(runs.map((r) => r.fork));
	const taskOf = new Map(d.tasks.filter((t) => t.fork).map((t) => [t.fork!, t]));
	const unplaced: [string, string][] = [
		...d.waiting.map((f): [string, string] => [f, "waiting"]),
		...d.loose.map((l): [string, string] => [l.fork, l.kind === "agent" ? "loose" : "pushed"]),
		...d.placing.map((f): [string, string] => [f, "placing"]),
	];
	for (const [fork, status] of unplaced) {
		if (seen.has(fork)) continue;
		seen.add(fork);
		const t = taskOf.get(fork);
		const person = t ? t.kind === "notagent" : !d.agents.some((a) => a.fork === fork);
		runs.push({ fork, prompt: t?.title ?? short(fork), started: 0, status, finished: null, log: null, ...(person ? { kind: "notagent" as const } : {}) });
	}
	return runs.filter((r) => !skip.has(r.fork)).map((r) => ({ fork: r.fork, title: r.prompt, person: r.kind === "notagent", status: r.status }));
}
