import { api, request } from "./session.svelte";
import type { Change, Commit, TreeEntry } from "./types";

// Reads of a bubble's representative (or any fork) through blingo's code-browser routes.
const q = (o: Record<string, string | number | undefined>) =>
	"?" + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "") as [string, string][]);

export const tree = (repo: string, fork: string, path: string, ref?: string) =>
	api<{ commit: Commit | null; entries: TreeEntry[] }>("GET", `/repos/${repo}/${fork}/tree${q({ path, ref })}`);

export const file = async (repo: string, fork: string, path: string, ref?: string) =>
	(await request("GET", `/repos/${repo}/${fork}${q({ path, ref })}`)).blob();

export const log = (repo: string, fork: string, offset = 0, limit = 30) =>
	api<Commit[]>("GET", `/repos/${repo}/${fork}/log${q({ offset, limit })}`);

export const commit = (repo: string, fork: string, hash: string) =>
	api<{ commit: Commit; files: Change[] }>("GET", `/repos/${repo}/${fork}/commits/${hash}`);

export const blob = async (repo: string, fork: string, hash: string) =>
	new Uint8Array(await (await request("GET", `/repos/${repo}/${fork}/blob/${hash}`)).arrayBuffer());

// A stored diff of a merged fork (unified diff text).
export const forkDiff = async (repo: string, fork: string) => (await request("GET", `/repos/${repo}/${fork}`)).text();

// Git's rule of thumb: a NUL byte early on means binary.
export const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

export const MAX_SHOWN = 400_000;
