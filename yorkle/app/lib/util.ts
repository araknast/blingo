import type { AgentRun, RepoState } from "./types";

// A repository's display name (its id when it has none), as /me lists it.
export const repoName = (repo: string, names?: Record<string, string>) => names?.[repo] || repo;

// Fork names are `<repo>-f-<id>`; the id alone is enough inside a repository.
export const short = (fork: string) => fork.split("-f-")[1] ?? fork;

export function ago(ms: number) {
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 45) return "just now";
	if (s < 90) return "a minute ago";
	if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
	if (s < 5400) return "an hour ago";
	if (s < 86400) return `${Math.round(s / 3600)} hours ago`;
	if (s < 172800) return "yesterday";
	if (s < 30 * 86400) return `${Math.round(s / 86400)} days ago`;
	return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// 35400000 → "35.4M", 194290 → "194.3K".
export const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

export function duration(ms: number) {
	const m = Math.round(ms / 60000);
	return m < 1 ? "under a minute" : m === 1 ? "1 minute" : m < 60 ? `${m} minutes` : `${(m / 60).toFixed(1)} hours`;
}

export const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export async function copy(text: string) {
	await navigator.clipboard.writeText(text);
}

// Calls fn now and every `ms` while the tab is visible. Returns a stop function.
export function poll(fn: () => unknown, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const run = async () => {
		clearTimeout(timer);
		if (stopped) return;
		if (document.visibilityState === "visible") await fn();
		if (!stopped) timer = setTimeout(run, ms);
	};
	const onVisible = () => document.visibilityState === "visible" && run();
	document.addEventListener("visibilitychange", onVisible);
	run();
	return () => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisible);
	};
}

// How to open the map's menu on this device.
export const menuGesture = globalThis.matchMedia?.("(pointer: coarse)").matches ? "Press and hold" : "Right-click";

export const firstLine =(s: string) => s.split("\n", 1)[0];

// Agent run status → what the UI calls it.
export const agentLabel = (status: string) =>
	({ running: "Working", ferging: "Resolving conflicts", placed: "Placed", loose: "Waiting for CI", planned: "Tasks added", failed: "Failed", lost: "Failed: sandbox lost", waiting: "Waiting for a push", pushed: "Pushed", placing: "Finding a bubble" })[status] ?? status;

// Notagent tasks that got a fork, as runs beside the agents' (a fork an agent ran on keeps that run).
export function notagentRuns(d: RepoState): AgentRun[] {
	const ran = new Set(d.agents.map((a) => a.fork));
	return d.tasks
		.filter((t) => t.kind === "notagent" && t.fork && !ran.has(t.fork))
		.map((t) => {
			const f = t.fork!;
			const status =
				t.status === "completed" ? "placed" : t.status === "failed" ? "failed" : d.placing.includes(f) ? "placing" : d.waiting.includes(f) ? "waiting" : "pushed";
			return { fork: f, prompt: t.title, started: t.created, status, finished: t.finished, log: null, kind: "notagent" as const };
		});
}
// Still going: an agent at work, or a person's fork not placed yet.
export const active = (r: AgentRun) => (r.kind === "notagent" ? r.status !== "placed" && r.status !== "failed" : r.status === "running");
// Agents' and people's runs, the ones still going first, then newest first.
export const allRuns = (d: RepoState) => [...d.agents, ...notagentRuns(d)].sort((a, b) => Number(active(b)) - Number(active(a)) || b.started - a.started);
// A run's status in words, from its fork when it's loose: CI and reviews say more than "loose".
export function runLabel(r: AgentRun, d: RepoState | null | undefined): string {
	const l = r.status === "loose" || r.status === "pushed" ? d?.loose.find((x) => x.fork === r.fork) : undefined;
	if (!l) return agentLabel(r.status);
	if (l.reviewManual === "pending") return "Waiting for your review";
	if (l.reviewAuto === "pending") return "Being reviewed";
	if (l.reviewAuto === "rejected" || l.reviewManual === "rejected") return "Review rejected";
	if (l.ci === "failed") return "CI failed";
	if (l.ci === "running") return "Waiting for CI";
	return r.status === "pushed" ? agentLabel("pushed") : "Ready to place";
}
// A run's mark (Glyph): shape and colour.
export function runMark(r: AgentRun, d?: RepoState | null): string {
	const l = r.status === "loose" || r.status === "pushed" ? d?.loose.find((x) => x.fork === r.fork) : undefined;
	if (l?.reviewManual === "pending") return "review";
	if (l && (l.ci === "failed" || l.reviewAuto === "rejected" || l.reviewManual === "rejected")) return "failed";
	if (r.status === "running") return "running";
	if (r.status === "failed" || r.status === "lost") return "failed";
	if (r.status === "placing" || r.status === "loose") return "placing";
	return active(r) ? "waiting" : "merged";
}
// Who did a run: an agent, a CI fixer, a superagent, or a person (a notagent).
export const runKind = (r: Pick<AgentRun, "fork" | "kind">) =>
	r.kind === "notagent" ? "Notagent" : r.fork.includes("-s-") ? "Superagent" : /-c\d+$/.test(r.fork) ? "CI fixer" : "Agent";
// The id part of a run's name, for display.
export const runId = (fork: string) => fork.split(/-[fsc]-/).at(-1) ?? fork;
