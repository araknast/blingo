import { expect, test } from "vitest";
import { DEFAULTS, NO_KEY, ciHostAllowed, deployHeaders, issuedToken, deployKey, deployValues, egress, gate, keyError, readSettings, updateSettings, type Settings } from "../src/settings";

const on = (o: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...o, ci: { ...DEFAULTS.ci, enabled: true, ...o.ci } });

test("settings updates are validated and merged", () => {
	const s = updateSettings(DEFAULTS, { ci: { enabled: true, command: " npm test ", hosts: ["Registry.npmjs.org", "registry.npmjs.org"] }, review: "both" });
	expect(s).toEqual({ ...DEFAULTS, review: "both", ci: { enabled: true, command: "npm test", hosts: ["registry.npmjs.org"] } });
	expect(updateSettings(DEFAULTS, {})).toEqual(DEFAULTS);
	expect(updateSettings(DEFAULTS, { review: "sometimes" })).toHaveProperty("error");
	expect(updateSettings(DEFAULTS, { maxAgentPushes: 0 })).toHaveProperty("error");
	expect(updateSettings(DEFAULTS, { ci: { hosts: ["http://evil"] } })).toHaveProperty("error");
	expect(updateSettings(DEFAULTS, { autoPlaceNotagents: "yes" })).toHaveProperty("error");
	expect(updateSettings(DEFAULTS, { fergeAgents: true, taskApproval: true })).toMatchObject({ fergeAgents: true, taskApproval: true });
	expect(updateSettings(DEFAULTS, { autoFerge: true })).toMatchObject({ autoFerge: true });
	expect(updateSettings(DEFAULTS, { autoFerge: 1 })).toHaveProperty("error");
});

test("CI egress: listed hosts and their subdomains only", () => {
	expect(ciHostAllowed(["registry.npmjs.org"], "registry.npmjs.org")).toBe(true);
	expect(ciHostAllowed(["npmjs.org"], "registry.npmjs.org")).toBe(true);
	expect(ciHostAllowed(["npmjs.org"], "evilnpmjs.org")).toBe(false);
	expect(ciHostAllowed([], "api.anthropic.com")).toBe(false);
});

test("egress: agents reach the internet, keys only go to their own provider", () => {
	const u = (s: string) => new URL(s);
	const agent = { agent: true, provider: "claude-subscription" as const };
	expect(egress(u("https://x.artifacts.cloudflare.net/r.git"), {})).toBe("pass");
	expect(egress(u("https://registry.npmjs.org/jq"), agent)).toBe("pass");
	expect(egress(u("http://deb.debian.org/debian"), agent)).toBe("pass");
	expect(egress(u("https://api.anthropic.com/v1/messages"), agent)).toBe("key");
	expect(egress(u("http://api.anthropic.com/v1/messages"), agent)).toEqual({ deny: "https only" });
	expect(egress(u("https://openrouter.ai/api"), agent)).toHaveProperty("deny");
	// No repository key: no model API at all (blingo has no key of its own to fall back on).
	expect(egress(u("https://api.anthropic.com/v1/messages"), { agent: true, provider: null })).toEqual({ deny: NO_KEY });
	expect(egress(u("https://registry.npmjs.org/jq"), { agent: true, provider: null })).toBe("pass");
	// CI and other Boxes stay locked down.
	expect(egress(u("https://registry.npmjs.org/jq"), { ci: ["registry.npmjs.org"] })).toBe("pass");
	expect(egress(u("https://example.com/"), { ci: ["registry.npmjs.org"] })).toHaveProperty("deny");
	expect(egress(u("https://api.anthropic.com/v1/messages"), { ci: [] })).toHaveProperty("deny");
	expect(egress(u("https://registry.npmjs.org/jq"), {})).toHaveProperty("deny");
});

test("gate: CI off always passes", () => {
	expect(gate(DEFAULTS, { ci: null, reviewAuto: null, reviewManual: null })).toBe("passed");
});

test("gate: CI must pass, then every required review approve", () => {
	const none = { reviewAuto: null, reviewManual: null };
	expect(gate(on(), { ci: "running", ...none })).toBe("waiting");
	expect(gate(on(), { ci: "failed", ...none })).toEqual({ failed: ["ci"] });
	expect(gate(on(), { ci: "passed", ...none })).toBe("passed");
	const both = on({ review: "both" });
	expect(gate(both, { ci: "passed", reviewAuto: "approved", reviewManual: "pending" })).toBe("waiting");
	expect(gate(both, { ci: "passed", reviewAuto: "approved", reviewManual: "approved" })).toBe("passed");
	expect(gate(both, { ci: "passed", reviewAuto: "rejected", reviewManual: "pending" })).toEqual({ failed: ["automatic review"] });
	expect(gate(on({ review: "manual" }), { ci: "passed", reviewAuto: null, reviewManual: "rejected" })).toEqual({ failed: ["manual review"] });
});

test("provider and per-role models", () => {
	const s = updateSettings(DEFAULTS, { provider: "openrouter", models: { agent: "anthropic/claude-sonnet-5.5", superagent: "" } });
	expect(s).toMatchObject({ provider: "openrouter", models: { agent: "anthropic/claude-sonnet-5.5", superagent: "", ferge: "" } });
	expect(updateSettings(DEFAULTS, { provider: "openai" })).toHaveProperty("error");
	expect(updateSettings(DEFAULTS, { models: { agent: "bad model; rm -rf" } })).toHaveProperty("error");
});

test("deployments are validated; auth hosts must be among their hosts; secret values are dropped", () => {
	const body = { deploys: [{ name: "prod", command: " ./ship ", hosts: ["API.example.com"], auth: [{ host: "api.example.com", header: "Authorization", value: "Bearer s3cret" }] }] };
	const s = updateSettings(DEFAULTS, body) as Settings;
	expect(s.deploys).toEqual([{ name: "prod", command: "./ship", hosts: ["api.example.com"], auth: [{ host: "api.example.com", header: "Authorization" }] }]);
	expect(JSON.stringify(s)).not.toContain("s3cret");
	expect(deployValues(body).get(deployKey("prod", "api.example.com", "Authorization"))).toBe("Bearer s3cret");
	const bad = (d: object) => expect(updateSettings(DEFAULTS, { deploys: [d] })).toHaveProperty("error");
	bad({ name: "a b", command: "x" });
	bad({ name: "p", command: "" });
	bad({ name: "p", command: "x", hosts: ["a.example.com"], auth: [{ host: "b.example.com", header: "X-Key" }] });
	bad({ name: "p", command: "x", hosts: ["a.example.com"], auth: [{ host: "a.example.com", header: "Host" }] });
	expect(updateSettings(DEFAULTS, { deploys: [{ name: "p", command: "x" }, { name: "p", command: "y" }] })).toHaveProperty("error");
});

test("a deployment's headers go only to their host (and its subdomains)", () => {
	const d = { name: "prod", command: "x", hosts: ["example.com"], auth: [{ host: "api.example.com", header: "X-Key" }] };
	const values = { [deployKey("prod", "api.example.com", "X-Key")]: "k" };
	expect(deployHeaders(d, "api.example.com", values)).toEqual([["X-Key", "k"]]);
	expect(deployHeaders(d, "v2.api.example.com", values)).toEqual([["X-Key", "k"]]);
	expect(deployHeaders(d, "example.com", values)).toEqual([]);
	expect(deployHeaders(d, "evilapi.example.com", values)).toEqual([]);
	expect(deployHeaders(d, "api.example.com", {})).toEqual([]); // no value stored
	expect(deployHeaders(undefined, "api.example.com", values)).toEqual([]);
});

test("a bearer JWT the host issued is kept; placeholders are replaced", () => {
	expect(issuedToken("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln-_x")).toBe(true);
	expect(issuedToken("Bearer cfat_000000000000000000000000000000000000000000000000")).toBe(false);
	expect(issuedToken("Bearer added-by-outbound")).toBe(false);
	expect(issuedToken(null)).toBe(false);
});

test("claude-subscription provider: accepted, and its key only goes to api.anthropic.com", () => {
	expect(updateSettings(DEFAULTS, { provider: "claude-subscription" })).toMatchObject({ provider: "claude-subscription" });
	expect(updateSettings(DEFAULTS, { provider: "anthropic" })).toHaveProperty("error");
	const sub = { agent: true, provider: "claude-subscription" as const };
	expect(egress(new URL("https://api.anthropic.com/v1/messages"), sub)).toBe("key");
	expect(egress(new URL("https://openrouter.ai/api/v1/messages"), sub)).toHaveProperty("deny");
});

test("readSettings: repositories on the dropped Anthropic API provider become claude-subscription", () => {
	expect(readSettings({ provider: "anthropic", reviewerProvider: "anthropic" } as never)).toEqual(DEFAULTS);
	expect(readSettings({ provider: "openrouter" }).provider).toBe("openrouter");
	expect(readSettings({}).provider).toBe("claude-subscription");
});

test("keyError: a Claude subscription takes only a setup-token token", () => {
	expect(keyError("claude-subscription", "sk-ant-oat01-abc")).toBeNull();
	expect(keyError("claude-subscription", "sk-ant-api03-abc")).toMatch(/API key/);
	expect(keyError("claude-subscription", "abc")).toMatch(/sk-ant-oat/);
	expect(keyError("openrouter", "sk-fake-not-real")).toBeNull();
});
