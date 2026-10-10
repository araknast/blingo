import { expect, test } from "vitest";
import { DEFAULTS, ciHostAllowed, gate, updateSettings, type Settings } from "../src/settings";

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
});

test("CI egress: listed hosts and their subdomains only", () => {
	expect(ciHostAllowed(["registry.npmjs.org"], "registry.npmjs.org")).toBe(true);
	expect(ciHostAllowed(["npmjs.org"], "registry.npmjs.org")).toBe(true);
	expect(ciHostAllowed(["npmjs.org"], "evilnpmjs.org")).toBe(false);
	expect(ciHostAllowed([], "api.anthropic.com")).toBe(false);
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
