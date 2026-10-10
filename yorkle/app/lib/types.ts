// Shapes returned by the blingo API (see backend/src/index.ts and RepoDO.list).

export type Me = { username: string; admin: boolean; repos: string[] };

// pending = its patch series is queued in the bubble; failed = the series didn't apply.
export type MemberStatus = "rep" | "pending" | "merged" | "conflict" | "failed";
export type Member = { name: string; bubble: string; status: MemberStatus; files: string[] };
export type Bubble = { id: string; visible: number | boolean; locked: boolean; members: Member[] };
export type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null };
export type TaskStatus = "open" | "in-progress" | "completed" | "failed";
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
};
export type MemoryItem = { id: string; text: string; author: string; created: number };
export type RepoState = {
	bubbles: Bubble[];
	conflicts: [string, string][];
	merging: [string, string][];
	waiting: string[];
	placing: string[];
	agents: AgentRun[];
	tasks: Task[];
	memory: MemoryItem[];
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
