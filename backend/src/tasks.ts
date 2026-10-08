// Pure task rules (tasktracker.md). No I/O: RepoDO loads rows, asks these, writes results.

export type TaskKind = "agent" | "notagent";
export type TaskStatus = "open" | "in-progress" | "completed" | "failed";
// `bubble`: where an open task without deps should start (null = any); once started, where it did.
export type TaskState = { id: string; status: TaskStatus; bubble: string | null; fork: string | null; deps: string[] };
export type ForkState = { name: string; bubble: string; status: string };
// A ferge's locked bubble still owes its conflicting files to bubble `into`.
export type Owed = { locked: string; into: string };

// Open tasks that may start now → the bubble to fork (null = the repository's base).
// No deps: its chosen bubble if it still exists, else `fallback`. With deps: every dep is completed
// and one visible bubble holds all their forks fully merged — merged or its rep, no pending members
// (an absorbed rep is pending while the members it carries already read as merged), and nothing
// owed to it by a ferge.
export function ready(
	tasks: TaskState[],
	forks: ForkState[],
	bubbles: { id: string; visible: boolean }[],
	owed: Owed[],
	fallback: string | null,
): Map<string, string | null> {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const forkOf = new Map(forks.map((f) => [f.name, f]));
	const visible = new Set(bubbles.filter((b) => b.visible).map((b) => b.id));
	const exists = new Set(bubbles.map((b) => b.id));
	const pending = new Set(forks.filter((f) => f.status === "pending").map((f) => f.bubble));
	const indebted = new Set(owed.map((o) => o.into));
	const out = new Map<string, string | null>();
	for (const t of tasks) {
		if (t.status !== "open") continue;
		if (!t.deps.length) {
			out.set(t.id, t.bubble && exists.has(t.bubble) ? t.bubble : fallback);
			continue;
		}
		const homes = new Set<string>();
		let ok = true;
		for (const d of t.deps) {
			const dep = byId.get(d);
			const f = dep?.status === "completed" && dep.fork ? forkOf.get(dep.fork) : undefined;
			if (!f || (f.status !== "merged" && f.status !== "rep")) ok = false;
			else homes.add(f.bubble);
		}
		const [home] = homes;
		if (ok && homes.size === 1 && visible.has(home) && !pending.has(home) && !indebted.has(home)) out.set(t.id, home);
	}
	return out;
}

// Bubble `from` was absorbed into `into`: rename it on both sides. A debt whose locked bubble has
// reached the bubble it owes (either merge direction) is paid and dropped.
export function renameOwed(rows: Owed[], from: string, into: string): Owed[] {
	const out = new Map<string, Owed>();
	for (const r of rows) {
		const o = { locked: r.locked === from ? into : r.locked, into: r.into === from ? into : r.into };
		if (o.locked !== o.into) out.set(`${o.locked}|${o.into}`, o);
	}
	return [...out.values()];
}

// A short title: the first non-empty line, cut at a word boundary (with "…") if over `max` characters.
export function shortTitle(text: string, max = 60): string {
	const line = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
	if (line.length <= max) return line;
	const cut = line.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export type PlanItem = { key: string; title: string; description: string; kind: TaskKind; deps: string[] };
export const MAX_PLAN = 30;

// Checks a superagent's plan: [{key, title, description, kind, deps}], deps by key within the plan,
// acyclic. Long titles are shortened rather than rejected.
export function validatePlan(raw: unknown): { items: PlanItem[] } | { error: string } {
	if (!Array.isArray(raw) || !raw.length) return { error: "plan must be a non-empty array" };
	if (raw.length > MAX_PLAN) return { error: `plan has more than ${MAX_PLAN} tasks` };
	const items: PlanItem[] = [];
	for (const x of raw as Record<string, unknown>[]) {
		const key = typeof x?.key === "string" ? x.key.trim() : "";
		const description = typeof x?.description === "string" ? x.description.trim() : "";
		const title = typeof x?.title === "string" ? shortTitle(x.title) : "";
		if (!key || !title || !description) return { error: "every task needs a key, a title and a description" };
		if (x.kind !== "agent" && x.kind !== "notagent") return { error: `task ${key}: kind must be agent or notagent` };
		const deps = x.deps ?? [];
		if (!Array.isArray(deps) || deps.some((d) => typeof d !== "string")) return { error: `task ${key}: deps must be keys` };
		items.push({ key, title, description, kind: x.kind, deps: [...new Set(deps as string[])] });
	}
	const keys = new Set(items.map((i) => i.key));
	if (keys.size !== items.length) return { error: "task keys must be unique" };
	for (const i of items) {
		const bad = i.deps.find((d) => !keys.has(d));
		if (bad) return { error: `task ${i.key}: unknown dep ${bad}` };
	}
	// Kahn: anything left after peeling off dep-free tasks is on a cycle.
	const left = new Map(items.map((i) => [i.key, new Set(i.deps)]));
	for (let changed = true; changed; ) {
		changed = false;
		for (const [k, deps] of left) {
			if ([...deps].every((d) => !left.has(d))) {
				left.delete(k);
				changed = true;
			}
		}
	}
	return left.size ? { error: `dependency cycle among ${[...left.keys()].join(", ")}` } : { items };
}

// A completed task's explanation: its fork's commit messages, newest first, down to where it started.
export function explanation(commits: { hash: string; message: string }[], base: string): string {
	const msgs: string[] = [];
	for (const c of commits) {
		if (c.hash === base) break;
		msgs.push(c.message.trim());
	}
	return msgs.filter(Boolean).join("\n\n");
}
