// Pure git-tree helpers for the code browser. Tree reads are passed in, so these unit-test without Artifacts.

export type TreeEntry = { name: string; type: string; hash: string };
export type ReadTree = (hash: string) => Promise<TreeEntry[] | null>;
export type Change = { path: string; status: "added" | "removed" | "modified"; oldHash: string | null; newHash: string | null };

// Entry at `path` ("a/b") below the root tree, or null. "" is the root itself.
export async function resolvePath(readTree: ReadTree, root: string, path: string): Promise<TreeEntry | null> {
	let cur: TreeEntry = { name: "", type: "tree", hash: root };
	for (const part of path.split("/").filter(Boolean)) {
		if (cur.type !== "tree") return null;
		const next = (await readTree(cur.hash))?.find((e) => e.name === part);
		if (!next) return null;
		cur = next;
	}
	return cur;
}

// Files that differ between two trees (old null = everything added). Equal subtrees are skipped by hash.
export async function diffTrees(readTree: ReadTree, oldHash: string | null, newHash: string | null, prefix = ""): Promise<Change[]> {
	if (oldHash === newHash) return [];
	const [a, b] = await Promise.all([oldHash ? readTree(oldHash) : [], newHash ? readTree(newHash) : []]);
	const olds = new Map((a ?? []).map((e) => [e.name, e]));
	const news = new Map((b ?? []).map((e) => [e.name, e]));
	const out: Change[] = [];
	for (const name of [...new Set([...olds.keys(), ...news.keys()])].sort()) {
		const o = olds.get(name);
		const n = news.get(name);
		if (o?.hash === n?.hash && o?.type === n?.type) continue;
		const path = prefix + name;
		const oTree = o?.type === "tree" ? o.hash : null;
		const nTree = n?.type === "tree" ? n.hash : null;
		if (oTree || nTree) out.push(...(await diffTrees(readTree, oTree, nTree, path + "/")));
		const oFile = o && o.type !== "tree" ? o.hash : null;
		const nFile = n && n.type !== "tree" ? n.hash : null;
		if (oFile || nFile) out.push({ path, status: !oFile ? "added" : !nFile ? "removed" : "modified", oldHash: oFile, newHash: nFile });
	}
	return out;
}

// `text` in parts of at most `size` UTF-16 units, never splitting a surrogate pair (SQLite keeps text as
// UTF-8, where half a pair is lost). Joined, they're `text` again; "" is one empty part.
export function splitParts(text: string, size: number): string[] {
	const out: string[] = [];
	let i = 0;
	do {
		let end = Math.min(i + size, text.length);
		if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--;
		out.push(text.slice(i, end));
		i = end;
	} while (i < text.length);
	return out;
}
