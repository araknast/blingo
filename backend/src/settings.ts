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
	// The merge loop ferges a conflicting pair by itself, once both are visible, unlocked and idle.
	autoFerge: boolean;
	// New tasks wait for a person to approve them (and may be edited until then).
	taskApproval: boolean;
	deploys: Deploy[];
};
// A deployment: `command` runs in a Box on a bubble's code, reaching only Artifacts and `hosts`. Each
// `auth` entry names a header Outbound adds to requests to that host (the value is kept apart, in
// RepoDO, and never returned), so no credential enters the sandbox.
export type Deploy = { name: string; command: string; hosts: string[]; auth: { host: string; header: string }[] };
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
	autoFerge: false,
	taskApproval: false,
	deploys: [],
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
			if (!isModelId(m[role])) return { error: `models.${role} must be a model id` };
			next.models[role] = m[role] as string;
		}
	}
	for (const k of ["autoPlaceNotagents", "fergeAgents", "autoFerge", "taskApproval"] as const) {
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
	if (b.deploys !== undefined) {
		const d = validateDeploys(b.deploys);
		if (typeof d === "string") return { error: d };
		next.deploys = d;
	}
	return next;
}

const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
function validateDeploys(raw: unknown): Deploy[] | string {
	if (!Array.isArray(raw) || raw.length > 10) return "deploys must be a list of at most 10 deployments";
	const out: Deploy[] = [];
	for (const x of raw as Record<string, unknown>[]) {
		const name = typeof x?.name === "string" ? x.name.trim() : "";
		if (!/^[\w-]{1,40}$/.test(name)) return "a deployment's name is 1 to 40 letters, digits, - or _";
		if (out.some((o) => o.name === name)) return `two deployments are named ${name}`;
		if (typeof x.command !== "string" || !x.command.trim() || x.command.length > 2000) return `deployment ${name}: command must be 1 to 2000 characters`;
		const hosts = x.hosts ?? [];
		if (!Array.isArray(hosts) || hosts.length > 20 || !hosts.every((h) => typeof h === "string" && HOST.test(h))) return `deployment ${name}: hosts must be up to 20 host names`;
		const lower = [...new Set((hosts as string[]).map((h) => h.toLowerCase()))];
		const auth = x.auth ?? [];
		if (!Array.isArray(auth) || auth.length > 10) return `deployment ${name}: auth must be a list of at most 10 headers`;
		const entries: Deploy["auth"] = [];
		for (const a of auth as Record<string, unknown>[]) {
			const host = typeof a?.host === "string" ? a.host.toLowerCase() : "";
			const header = typeof a?.header === "string" ? a.header.trim() : "";
			if (!HOST.test(host) || !ciHostAllowed(lower, host)) return `deployment ${name}: auth host ${host || "?"} must be one of its hosts`;
			if (!/^[\w-]{1,60}$/.test(header) || /^(host|content-length|transfer-encoding)$/i.test(header)) return `deployment ${name}: bad header name`;
			if (entries.some((e) => e.host === host && e.header.toLowerCase() === header.toLowerCase())) return `deployment ${name}: ${header} for ${host} is listed twice`;
			entries.push({ host, header });
		}
		out.push({ name, command: x.command.trim(), hosts: lower, auth: entries });
	}
	return out;
}

// The secret values sent with a settings update: [`name|host|header` → value] for entries that
// carry a non-empty `value`. (updateSettings drops them; RepoDO stores them apart.)
export function deployValues(body: unknown): Map<string, string> {
	const out = new Map<string, string>();
	const deploys = (body as { deploys?: unknown } | null)?.deploys;
	if (!Array.isArray(deploys)) return out;
	for (const d of deploys as { name?: string; auth?: { host?: string; header?: string; value?: unknown }[] }[])
		for (const a of d?.auth ?? []) if (typeof a?.value === "string" && a.value && a.value.length <= 2000) out.set(deployKey(String(d.name).trim(), String(a.host).toLowerCase(), String(a.header).trim()), a.value);
	return out;
}
export const deployKey = (name: string, host: string, header: string) => `${name}|${host}|${header.toLowerCase()}`;

// The headers Outbound adds to a deployment's request to `hostname`, from its stored values.
export function deployHeaders(d: Deploy | undefined, hostname: string, values: Record<string, string>): [string, string][] {
	return (d?.auth ?? []).filter((a) => ciHostAllowed([a.host], hostname) && values[deployKey(d!.name, a.host, a.header)]).map((a) => [a.header, values[deployKey(d!.name, a.host, a.header)]]);
}

// May a request to `hostname` leave a CI Box? Exactly a listed host or one of its subdomains.
export const ciHostAllowed = (hosts: string[], hostname: string) => hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));

// A model id as the provider names it ("" = the default).
export const isModelId = (m: unknown): m is string => typeof m === "string" && /^[\w./:-]{0,100}$/.test(m);

export const MODEL_HOSTS: Record<Provider, string> = { anthropic: "api.anthropic.com", openrouter: "openrouter.ai" };
export const NO_KEY = "this repository has no API key: set one in its settings";

// Where a request out of a Box may go: "pass" = straight out, "key" = to the repository's model API
// with its key added (by Outbound), else why not. Artifacts git always (https). A CI Box: its hosts
// (https). An agent Box: anywhere, http too (apt mirrors), but a model API only over https, only its
// repository's provider, and only once the repository has a key (provider null = no key). Others:
// Artifacts only.
export function egress(url: URL, box: { ci?: string[]; agent?: boolean; provider?: Provider | null }): "pass" | "key" | { deny: string } {
	const host = url.hostname;
	const https = url.protocol === "https:";
	if (https && host.endsWith(".artifacts.cloudflare.net")) return "pass";
	if (box.ci) return https && ciHostAllowed(box.ci, host) ? "pass" : { deny: `${host} not reachable from CI` };
	if (!box.agent) return { deny: `${host} not reachable` };
	const model = (Object.keys(MODEL_HOSTS) as Provider[]).find((p) => MODEL_HOSTS[p] === host);
	if (!model) return "pass";
	if (!box.provider) return { deny: NO_KEY };
	if (model !== box.provider) return { deny: `${host} not reachable: this repository uses ${box.provider}` };
	return https ? "key" : { deny: "https only" };
}

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
