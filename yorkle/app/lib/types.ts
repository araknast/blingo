// Shapes returned by the blingo API (see backend/src/index.ts and RepoDO.list).

// `names`: repository id → display name (repositories from before names have none).
export type Me = { username: string; admin: boolean; repos: string[]; names?: Record<string, string>; created?: Record<string, number> };

// pending = its patch series is queued in the bubble; failed = the series didn't apply.
export type MemberStatus = "rep" | "pending" | "merged" | "conflict" | "failed";
export type Member = { name: string; bubble: string; status: MemberStatus; files: string[] };
// `ferge`: the locked bubble a ferge made, holding the conflicting files. `parent`: the bubble it split off
// from, if known.
export type Bubble = { id: string; name: string; visible: number | boolean; locked: boolean; ferge: boolean; members: Member[]; parent?: string | null };
// kind "notagent": a person's fork, shown as a run (util.ts notagentRuns); its page is the fork's.
export type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null; kind?: "notagent" };
export type TaskStatus = "awaiting-approval" | "open" | "in-progress" | "completed" | "failed";
export type Task = {
	id: string;
	title: string;
	description: string;
	kind: "agent" | "notagent";
	status: TaskStatus;
	bubble: string | null;
	fork: string | null;
	deps: string[];
	explanation: string | null;
	superagent: string | null;
	created: number;
	finished: number | null;
	ready: boolean;
	skills: string[] | null;
	role: "agent" | "superagent" | "ferge" | null;
};
// A notagent fork that was pushed to and isn't placed yet (auto-placement off, or placement failed).
// With CI on, an agent's fork is loose too while CI runs. `ci` and the reviews are for its latest push.
export type LooseFork = {
	fork: string;
	kind: "agent" | "notagent";
	pushes: number;
	pushable: boolean;
	reason: string | null;
	ci: "running" | "passed" | "failed" | null;
	ciLog: string | null;
	reviewAuto: "pending" | "approved" | "rejected" | null;
	reviewManual: "pending" | "approved" | "rejected" | null;
	reviewNote: string | null;
};
// `hasValue`: a credential is stored for the header (its value is never sent back).
export type DeployConfig = { name: string; command: string; hosts: string[]; auth: { host: string; header: string; hasValue: boolean }[] };
export type DeployRun = { id: string; name: string; bubble: string; head: string; status: "running" | "succeeded" | "failed"; started: number; finished: number | null; log: string | null; by: string };
export type Settings = {
	autoPlaceNotagents: boolean;
	ci: { enabled: boolean; command: string; hosts: string[] };
	review: "none" | "auto" | "manual" | "both";
	maxAgentPushes: number;
	provider: "openrouter" | "claude-subscription";
	models: { agent: string; superagent: string; ferge: string };
	fergeAgents: boolean;
	autoFerge: boolean;
	taskApproval: boolean;
	deploys: DeployConfig[];
	hasKey: boolean;
	// The provider the stored key was saved for; null when unknown (saved before this was recorded).
	keyProvider?: "anthropic" | "openrouter" | "claude-subscription" | null;
	hasReviewerKey: boolean;
};
// `needs`: what needs a person, as the map's "Needs you" list counts it (less new memory notes).
export type RepoSummary = { bubbles: number; forks: number; working: number; conflicts: number; needs?: number };
export type Skill = { name: string; description: string; created: number };
export type MemoryItem = { id: string; text: string; author: string; created: number };
export type RepoState = {
	name: string | null;
	bubbles: Bubble[];
	conflicts: [string, string][];
	merging: [string, string][];
	waiting: string[];
	placing: string[];
	loose: LooseFork[];
	settings: Settings;
	agents: AgentRun[];
	tasks: Task[];
	memory: MemoryItem[];
	skills: Skill[];
	deploys: DeployRun[];
};

export type Commit = {
	hash: string;
	treeHash: string;
	message: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
	parents: string[];
	authoredAt: number;
	committedAt: number;
};
export type TreeEntry = { name: string; mode: string; hash: string; type: "tree" | "blob" | "symlink" | "gitlink" | "exec" };
export type Change = { path: string; status: "added" | "removed" | "modified"; oldHash: string | null; newHash: string | null };
