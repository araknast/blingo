import type { Bubble, Member, RepoState } from "./types";

// A scripted repository for the splash page. It loops exactly: forks arrive and merge, one bubble merges
// into another, the grown bubbles ship (back to how they started), and the step after the last is the
// first. Every bubble and agent sits at a fixed anchor, so nothing moves across the loop.
const f = (id: string) => `r-demo-f-${id}`;
const m = (id: string, status: Member["status"], files: string[], bubble: string): Member => ({ name: f(id), bubble: f(bubble), status, files });
const NAMES: Record<string, string> = { "3fa1c09e": "demo", d94b7e13: "sunny otter", "5c08aa71": "calm river" };
const b = (id: string, members: Member[], visible = true): Bubble => ({ id: f(id), name: NAMES[id] ?? "", visible, locked: false, ferge: false, members });

const A0 = [
	m("3fa1c09e", "rep", ["src/parser.ts", "src/lexer.ts", "src/ast.ts"], "3fa1c09e"),
	m("8b20d4f1", "merged", ["src/lexer.ts"], "3fa1c09e"),
	m("c71e5a02", "merged", ["test/parser.test.ts"], "3fa1c09e"),
];
const B0 = [m("d94b7e13", "rep", ["web/index.html", "web/app.css"], "d94b7e13"), m("0e6f3b88", "merged", ["web/app.ts"], "d94b7e13")];
const C0 = [m("5c08aa71", "rep", ["README.md", "docs/guide.md"], "5c08aa71")];
const A = (...extra: Member[]) => b("3fa1c09e", [...A0, ...extra]);
const B = (extra: Member[] = [], visible = true) => b("d94b7e13", [...B0, ...extra], visible);
const C = (visible = true) => b("5c08aa71", C0, visible);

const N = m("44f0b9a6", "pending", ["src/eval.ts"], "3fa1c09e"); // a person's fork
const P1 = m("a7c3e5d2", "pending", ["web/keys.ts"], "d94b7e13");
const P2 = m("e2b8f6c1", "pending", ["cli/main.ts", "cli/export.ts"], "3fa1c09e");
const merged = (x: Member, bubble = x.bubble): Member => ({ ...x, status: "merged", bubble });
const intoB = C0.map((x) => merged(x, f("d94b7e13")));

const started = Date.now();
const agents = (...ms: [Member, string][]) => ms.map(([x, prompt]) => ({ fork: x.name, prompt, started, status: "running", finished: null, log: null }));
const R1: [Member, string] = [P1, "Add keyboard shortcuts to the editor"];
const R2: [Member, string] = [P2, "Write a CLI for exporting reports"];

const state = (bubbles: Bubble[], o: Partial<RepoState> = {}): RepoState => ({ name: "demo", bubbles, conflicts: [], merging: [], waiting: [], placing: [], loose: [], settings: { autoPlaceNotagents: true, ci: { enabled: false, command: "", hosts: [] }, review: "none", maxAgentPushes: 3, provider: "anthropic", models: { agent: "", superagent: "", ferge: "" }, fergeAgents: false, taskApproval: false, hasKey: false }, agents: [], tasks: [], memory: [], ...o });

// N's task, so its pill is labelled like a real person's fork.
const tasks = [{ id: "t-demo", title: "Fix the login redirect", description: "", kind: "notagent" as const, status: "in-progress" as const, bubble: f("3fa1c09e"), fork: N.name, deps: [], explanation: null, superagent: null, created: started, finished: null, ready: false, role: null }];

export const demoSteps: RepoState[] = [
	state([A(), B(), C()], { waiting: [N.name], agents: agents(R1, R2), tasks }),
	state([A(), B(), C()], { placing: [N.name], agents: agents(R1, R2), tasks }),
	state([A(N), B(), C()], { agents: agents(R1, R2) }),
	state([A(merged(N)), B([P1]), C()], { agents: agents(R2) }),
	state([A(merged(N)), B([merged(P1)]), C()], { agents: agents(R2) }),
	state([A(merged(N)), B([merged(P1)], false), C(false)], { agents: agents(R2), merging: [[f("d94b7e13"), f("5c08aa71")]] }),
	state([A(merged(N), P2), B([merged(P1), ...intoB])]),
	state([A(merged(N), merged(P2)), B([merged(P1), ...intoB])]),
	// Ship: the grown bubbles go back to how they started; the loop's first step then brings C back.
	state([A(), B()]),
];

// World positions (the map's centre is 0,0) of every bubble and agent pill in the story.
export const demoAnchors: Record<string, { x: number; y: number }> = {
	[f("3fa1c09e")]: { x: -160, y: 10 },
	[f("d94b7e13")]: { x: 160, y: -10 },
	[f("5c08aa71")]: { x: 10, y: 170 },
	[P1.name]: { x: 170, y: -160 },
	[P2.name]: { x: -170, y: -150 },
	[N.name]: { x: 0, y: -250 },
};
