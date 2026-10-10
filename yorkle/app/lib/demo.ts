import type { Bubble, Member, RepoState } from "./types";

// A scripted repository for the splash page: forks arrive, join bubbles, merge, and two bubbles conflict.
const f = (id: string) => `r-demo-f-${id}`;
const m = (id: string, status: Member["status"], files: string[], bubble: string): Member => ({ name: f(id), bubble: f(bubble), status, files });
const NAMES: Record<string, string> = { "3fa1c09e": "demo", d94b7e13: "sunny otter", "5c08aa71": "calm river", e2b8f6c1: "brisk heron" };
const b = (id: string, members: Member[], visible = true): Bubble => ({ id: f(id), name: NAMES[id] ?? "", visible, locked: false, ferge: false, members });

const A = (extra: Member[] = []) =>
	b("3fa1c09e", [
		m("3fa1c09e", "rep", ["src/parser.ts", "src/lexer.ts", "src/ast.ts"], "3fa1c09e"),
		m("8b20d4f1", "merged", ["src/lexer.ts"], "3fa1c09e"),
		m("c71e5a02", "merged", ["test/parser.test.ts"], "3fa1c09e"),
		...extra,
	]);
const B = (extra: Member[] = [], visible = true) =>
	b(
		"d94b7e13",
		[
			m("d94b7e13", "rep", ["web/index.html", "web/app.css"], "d94b7e13"),
			m("0e6f3b88", "merged", ["web/app.ts"], "d94b7e13"),
			...extra,
		],
		visible,
	);
const C = (visible = true) =>
	b("5c08aa71", [m("5c08aa71", "rep", ["README.md", "docs/guide.md"], "5c08aa71"), m("19d2fe40", "merged", ["docs/api.md"], "5c08aa71")], visible);

const agents = (...prompts: [string, string][]) =>
	prompts.map(([id, prompt]) => ({ fork: f(id), prompt, started: Date.now(), status: "running", finished: null, log: null }));
const P1: [string, string] = ["a7c3e5d2", "Add keyboard shortcuts to the editor"];
const P2: [string, string] = ["e2b8f6c1", "Write a CLI for exporting reports"];

const state = (bubbles: Bubble[], o: Partial<RepoState> = {}): RepoState => ({ name: "demo", bubbles, conflicts: [], merging: [], waiting: [], placing: [], loose: [], settings: { autoPlaceNotagents: true, ci: { enabled: false, command: "", hosts: [] }, review: "none", maxAgentPushes: 3, provider: "anthropic", models: { agent: "", superagent: "", ferge: "" }, fergeAgents: false, taskApproval: false, deploys: [], hasKey: false }, agents: [], tasks: [], memory: [], skills: [], deploys: [], ...o });

export const demoSteps: RepoState[] = [
	state([A(), B(), C()], { waiting: [f("44f0b9a6")], agents: agents(P1, P2) }),
	state([A(), B(), C()], { placing: [f("44f0b9a6")], agents: agents(P1, P2) }),
	state([A([m("44f0b9a6", "pending", ["src/eval.ts"], "3fa1c09e")]), B(), C()], { agents: agents(P1, P2) }),
	state([A([m("44f0b9a6", "merged", ["src/eval.ts"], "3fa1c09e")]), B([m("a7c3e5d2", "pending", ["web/keys.ts"], "d94b7e13")]), C()], {
		agents: agents(P2),
	}),
	state([A([m("44f0b9a6", "merged", ["src/eval.ts"], "3fa1c09e")]), B([m("a7c3e5d2", "merged", ["web/keys.ts"], "d94b7e13")]), C()], {
		agents: agents(P2),
		conflicts: [[f("3fa1c09e"), f("5c08aa71")]],
		waiting: [f("b1d7c2e8")],
	}),
	state([A([m("44f0b9a6", "merged", ["src/eval.ts"], "3fa1c09e")]), B([m("a7c3e5d2", "merged", ["web/keys.ts"], "d94b7e13")], false), C(false)], {
		agents: agents(P2),
		conflicts: [[f("3fa1c09e"), f("5c08aa71")]],
		waiting: [f("b1d7c2e8")],
	}),
	state(
		[
			A([m("44f0b9a6", "merged", ["src/eval.ts"], "3fa1c09e")]),
			B([
				m("a7c3e5d2", "merged", ["web/keys.ts"], "d94b7e13"),
				m("5c08aa71", "merged", ["README.md", "docs/guide.md"], "d94b7e13"),
				m("19d2fe40", "merged", ["docs/api.md"], "d94b7e13"),
			]),
		],
		{ agents: agents(P2), waiting: [f("b1d7c2e8")] },
	),
	state(
		[
			A([m("44f0b9a6", "merged", ["src/eval.ts"], "3fa1c09e")]),
			B([
				m("a7c3e5d2", "merged", ["web/keys.ts"], "d94b7e13"),
				m("5c08aa71", "merged", ["README.md", "docs/guide.md"], "d94b7e13"),
				m("19d2fe40", "merged", ["docs/api.md"], "d94b7e13"),
			]),
			b("e2b8f6c1", [m("e2b8f6c1", "rep", ["cli/main.ts", "cli/export.ts", "src/parser.ts"], "e2b8f6c1")]),
		],
		{ waiting: [f("b1d7c2e8")] },
	),
];
