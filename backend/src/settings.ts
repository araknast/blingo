// Repository settings and the CI gate a loose fork must pass before placement. Pure: RepoDO stores
// the settings and the fork's CI and review results, and asks these.

export type Review = "none" | "auto" | "manual" | "both";
export type Settings = {
	// Place a notagent fork as soon as it is pushed (and, with CI on, passes it); else on request.
	autoPlaceNotagents: boolean;
	// CI: `command` runs on every push to a loose fork, in a Box that can reach only Artifacts and `hosts`.
	ci: { enabled: boolean; command: string; hosts: string[] };
	// Review is part of CI: automatic (a Reviewer agent), manual (in the UI), or both.
	review: Review;
	// Pushes an agent (and its CI fixers) gets before its fork becomes a notagent's.
	maxAgentPushes: number;
	// Whose API the repository's API key is for, and the model each kind of agent uses ("" = the
	// Worker's MODEL). The key itself is stored apart and never returned.
	provider: Provider;
	models: { agent: string; superagent: string; ferge: string };
	// A ferge also files an agent task (model `models.ferge`) to resolve its conflict markers.
	fergeAgents: boolean;
	// New tasks wait for a person to approve them (and may be edited until then).
	taskApproval: boolean;
};
export type Provider = "anthropic" | "openrouter";
export type Role = keyof Settings["models"];

export const DEFAULTS: Settings = {
	autoPlaceNotagents: true,
	ci: { enabled: false, command: "", hosts: ["registry.npmjs.org"] },
	review: "none",
	maxAgentPushes: 3,
	provider: "anthropic",
	models: { agent: "", superagent: "", ferge: "" },
	fergeAgents: false,
	taskApproval: false,
};

// Applies a settings update from the API to `current`; returns the new settings or what's wrong.
export function updateSettings(current: Settings, body: unknown): Settings | { error: string } {
	const b = (body ?? {}) as Record<string, unknown>;
	const next: Settings = { ...current, ci: { ...current.ci }, models: { ...current.models } };
	if (b.provider !== undefined) {
		if (b.provider !== "anthropic" && b.provider !== "openrouter") return { error: "provider must be anthropic or openrouter" };
		next.provider = b.provider;
	}
	if (b.models !== undefined) {
		const m = b.models as Record<string, unknown>;
		if (typeof m !== "object" || m === null) return { error: "models must be an object" };
		for (const role of ["agent", "superagent", "ferge"] as const) {
			if (m[role] === undefined) continue;
			if (typeof m[role] !== "string" || !/^[\w./:-]{0,100}$/.test(m[role] as string)) return { error: `models.${role} must be a model id` };
			next.models[role] = m[role] as string;
		}
	}
	for (const k of ["autoPlaceNotagents", "fergeAgents", "taskApproval"] as const) {
		if (b[k] === undefined) continue;
		if (typeof b[k] !== "boolean") return { error: `${k} must be true or false` };
		next[k] = b[k];
	}
	if (b.review !== undefined) {
		if (!["none", "auto", "manual", "both"].includes(b.review as string)) return { error: "review must be none, auto, manual or both" };
		next.review = b.review as Review;
	}
	if (b.maxAgentPushes !== undefined) {
		const n = b.maxAgentPushes;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) return { error: "maxAgentPushes must be a whole number from 1 to 20" };
		next.maxAgentPushes = n;
	}
	if (b.ci !== undefined) {
		const c = b.ci as Record<string, unknown>;
		if (typeof c !== "object" || c === null) return { error: "ci must be an object" };
		if (c.enabled !== undefined) {
			if (typeof c.enabled !== "boolean") return { error: "ci.enabled must be true or false" };
			next.ci.enabled = c.enabled;
		}
		if (c.command !== undefined) {
			if (typeof c.command !== "string" || c.command.length > 2000) return { error: "ci.command must be a string of at most 2000 characters" };
			next.ci.command = c.command.trim();
		}
		if (c.hosts !== undefined) {
			const ok = Array.isArray(c.hosts) && c.hosts.length <= 20 && c.hosts.every((h) => typeof h === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
			if (!ok) return { error: "ci.hosts must be up to 20 host names" };
			next.ci.hosts = [...new Set((c.hosts as string[]).map((h) => h.toLowerCase()))];
		}
	}
	return next;
}

// May a request to `hostname` leave a CI Box? Exactly a listed host or one of its subdomains.
export const ciHostAllowed = (hosts: string[], hostname: string) => hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));

// A loose fork's CI results for its current head: `ci` running / passed / failed, and each review
// pending / approved / rejected (null = not required).
export type CiState = { ci: string | null; reviewAuto: string | null; reviewManual: string | null };

// passed = it may be placed; failed = a step failed (what to tell a fixer or the human); waiting =
// still running, or waiting for a review.
export function gate(s: Settings, f: CiState): "passed" | "waiting" | { failed: string[] } {
	if (!s.ci.enabled) return "passed";
	if (f.ci === "failed") return { failed: ["ci"] };
	if (f.ci !== "passed") return "waiting";
	const failed = [f.reviewAuto === "rejected" && "automatic review", f.reviewManual === "rejected" && "manual review"].filter(Boolean) as string[];
	if (failed.length) return { failed };
	const needAuto = s.review === "auto" || s.review === "both";
	const needManual = s.review === "manual" || s.review === "both";
	if ((needAuto && f.reviewAuto !== "approved") || (needManual && f.reviewManual !== "approved")) return "waiting";
	return "passed";
}
