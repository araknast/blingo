// Shapes returned by the blingo API (see backend/src/index.ts and RepoDO.list).

export type Me = { username: string; admin: boolean; repos: string[] };

export type MemberStatus = "rep" | "pending" | "merged" | "conflict";
export type Member = { name: string; bubble: string; status: MemberStatus; files: string[] };
export type Bubble = { id: string; visible: number | boolean; locked: boolean; members: Member[] };
export type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null };
export type RepoState = {
	bubbles: Bubble[];
	conflicts: [string, string][];
	waiting: string[];
	placing: string[];
	agents: AgentRun[];
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
