// Pure bubble rules from design.md. No I/O: RepoDO loads rows, asks these, writes results.

// A member's change table: the files it changed from its basis. `seq` orders applied tables
// (null = still queued, not in the representative yet).
export type Table = { files: string[]; seq: number | null };
// Locked bubbles stay placeable but never merge with (or get merged into by) another bubble.
// `epoch` changes whenever the bubble's code changes other than by applying a member (absorb, ferge).
export type Bubble = { id: string; files: Set<string>; visible: boolean; locked?: boolean; epoch?: number; ferge?: boolean; tables?: Table[] };
// Where a fork started: a bubble as it was at `epoch`, with every table up to `seq` applied.
export type Basis = { bubble: string; epoch: number; seq: number };

// |files(a) ∩ files(b)| — symmetric, so "distance from a to b" == "from b to a".
export function distance(a: Bubble, b: Bubble): number {
	let n = 0;
	for (const f of b.files) if (a.files.has(f)) n++;
	return n;
}

// Where a fork's patches go: the first visible bubble they apply to cleanly, "new" if none, or null
// for a fork of a ferge bubble that can't go back into it. A patch applies cleanly where each of
// its files is exactly as it was in the fork's basis:
// - its home bubble (the basis, unchanged since but for applied members): no table applied after
//   the basis, or still queued, touches its files;
// - any other bubble: neither that bubble nor the basis bubble (now `basisFiles`, a superset of
//   what it was) ever changed them, so both hold the base repository's version.
// The home bubble is tried first; a ferge bubble's forks only ever go home.
export function placeFork(bubbles: Bubble[], files: string[], basis: Basis | null, basisFiles: Set<string>): string | null {
	const fs = new Set(files);
	const touches = (paths: Iterable<string>) => {
		for (const p of paths) if (fs.has(p)) return true;
		return false;
	};
	const home = basis && bubbles.find((b) => b.id === basis.bubble && (b.epoch ?? 0) === basis.epoch);
	if (home && home.visible && !home.tables?.some((t) => (t.seq === null || t.seq > basis!.seq) && touches(t.files))) return home.id;
	if (home?.ferge) return null;
	if (touches(basisFiles)) return "new";
	return bubbles.find((b) => b.visible && b !== home && !touches(b.files))?.id ?? "new";
}

export const conflictKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Bubble `from` was absorbed into `into`: its conflicts now belong to `into`. A pair of the two
// themselves disappears, and pairs that become identical collapse.
export function renameConflicts(keys: string[], from: string, into: string): string[] {
	const out = new Set<string>();
	for (const k of keys) {
		const [a, b] = k.split("|").map((x) => (x === from ? into : x));
		if (a !== b) out.add(conflictKey(a, b));
	}
	return [...out];
}

// Nearest visible, unlocked, non-conflicting neighbour of `id` (ties → earliest), or null.
export function nearestNeighbour(id: string, bubbles: Bubble[], conflicts: Set<string>): string | null {
	const self = bubbles.find((h) => h.id === id);
	if (!self || self.locked) return null;
	let best: Bubble | null = null;
	let bestD = Infinity;
	for (const h of bubbles) {
		if (h.id === id || !h.visible || h.locked || conflicts.has(conflictKey(id, h.id))) continue;
		const d = distance(self, h);
		if (d < bestD) [best, bestD] = [h, d];
	}
	return best?.id ?? null;
}
