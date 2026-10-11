import type { AgentRun, RepoState } from "./types";
import { agentLabel, allRuns, active, short } from "./util";

// What a person has to act on. Clean merges and agents at work are background; these aren't. Each belongs
// to the tab where it's dealt with (its badge counts it); the Overview lists them all.
export type Tab = "bubbles" | "agents" | "tasks" | "deploy" | "memory" | "settings";
export type Need = { key: string; tab: Tab } & (
	| { kind: "conflict"; a: string; b: string }
	// `mark`: the Glyph it's drawn with.
	| { kind: "fork"; fork: string; title: string; why: string; mark: "review" | "waiting" | "failed" }
	| { kind: "task"; id: string; title: string; why: string; mark: "approval" | "failed" }
	| { kind: "member"; bubble: string; fork: string; why: string }
	// A ferge's locked bubble: its conflicting files wait to be fixed and the bubble unlocked.
	| { kind: "ferge"; bubble: string; why: string }
	// Something on a tab with no item of its own to link to (a setting, a deployment, memory).
	| { kind: "page"; title: string; why: string }
);

const PROVIDER = { anthropic: "the Anthropic API", openrouter: "OpenRouter", "claude-subscription": "a Claude subscription" };

// The backend counts the same things for the repository list (RepoDO.needsCount): keep the two in step.
// `memorySeen`: when this viewer last opened the Memory tab; notes agents wrote since then need a look.
export function needs(d: RepoState, memorySeen = Infinity): Need[] {
	const out: Need[] = d.conflicts.map(([a, b]) => ({ kind: "conflict", tab: "bubbles", key: `c:${a}|${b}`, a, b }));
	// A fork goes by its task's title, else its agent's prompt.
	const titleOf = new Map([...d.agents.map((a): [string, string] => [a.fork, a.prompt]), ...d.tasks.filter((t) => t.fork).map((t): [string, string] => [t.fork!, t.title])]);
	for (const l of d.loose) {
		const why = looseWhy(l, d.settings.autoPlaceNotagents);
		const mark = why === "Waiting for your review" ? "review" : why === "Ready to place" ? "waiting" : "failed";
		if (why) out.push({ kind: "fork", tab: "agents", key: `f:${l.fork}`, fork: l.fork, title: titleOf.get(l.fork) ?? short(l.fork), why, mark });
	}
	const runOf = new Map(d.agents.map((a) => [a.fork, a]));
	for (const t of d.tasks) {
		if (t.status === "awaiting-approval") out.push({ kind: "task", tab: "tasks", key: `t:${t.id}`, id: t.id, title: t.title, why: "Waiting for your approval", mark: "approval" });
		if (t.status !== "failed") continue;
		const run = t.fork ? runOf.get(t.fork) : undefined;
		const what = run ? `Agent ${agentLabel(run.status).toLowerCase()}` : "Task failed";
		out.push({ kind: "task", tab: "tasks", key: `t:${t.id}`, id: t.id, title: t.title, why: `${what}. Retry it from its task`, mark: "failed" });
	}
	for (const b of d.bubbles) {
		for (const m of b.members)
			if (m.status === "failed") out.push({ kind: "member", tab: "bubbles", key: `m:${m.name}`, bubble: b.id, fork: m.name, why: "Its changes didn't apply" });
		if (b.ferge && b.locked) out.push({ kind: "ferge", tab: "bubbles", key: `g:${b.id}`, bubble: b.id, why: "Fix its conflicting files in a fork, then unlock it" });
	}
	// No key isn't a problem: a repository runs on notagents alone. A key for another provider is: agents fail.
	const s = d.settings;
	if (s.hasKey && s.keyProvider && s.keyProvider !== s.provider)
		out.push({ kind: "page", key: "k:provider", tab: "settings", title: "The API key doesn't match", why: `It was saved for ${PROVIDER[s.keyProvider]}, but agents use ${PROVIDER[s.provider]}` });
	// A deployment whose last run failed, until it runs again.
	const last = new Map<string, RepoState["deploys"][number]>();
	for (const r of d.deploys) if ((last.get(r.name)?.started ?? -1) < r.started) last.set(r.name, r);
	for (const r of last.values())
		if (r.status === "failed") out.push({ kind: "page", key: `d:${r.id}`, tab: "deploy", title: `Deployment ${r.name} failed`, why: "Its last run failed. Read its log, then run it again" });
	const fresh = d.memory.filter((m) => isRun(m.author) && m.created > memorySeen).length;
	if (fresh) out.push({ kind: "page", key: "n:memory", tab: "memory", title: `${fresh === 1 ? "A new note" : `${fresh} new notes`} from agents`, why: "Every agent reads them. Check they're right" });
	return out;
}

// How many items each tab has.
export function needsByTab(d: RepoState, memorySeen = Infinity): Partial<Record<Tab, number>> {
	const by: Partial<Record<Tab, number>> = {};
	for (const n of needs(d, memorySeen)) by[n.tab] = (by[n.tab] ?? 0) + 1;
	return by;
}

// Memory notes agents leave are authored by their run's id (an agent's fork, a superagent or CI fixer run).
export const isRun = (author: string) => /-[fsc]-/.test(author);

// A loose fork needs a person when a review waits on them, or when it's theirs (a notagent, or an agent's
// fork handed over) and something stopped it. An agent's own failed CI is its fixer's job, not theirs.
export function looseWhy(l: RepoState["loose"][number], autoPlace: boolean): string | null {
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
