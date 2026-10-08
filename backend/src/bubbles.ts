// Pure bubble rules from design.md. No I/O: RepoDO loads rows, asks these, writes results.

// Locked bubbles stay placeable but never merge with (or get merged into by) another bubble.
export type Bubble = { id: string; files: Set<string>; visible: boolean; locked?: boolean };

// |files(a) ∩ files(b)| — symmetric, so "distance from a to b" == "from b to a".
export function distance(a: Bubble, b: Bubble): number {
	let n = 0;
	for (const f of b.files) if (a.files.has(f)) n++;
	return n;
}

// Can a fork join this bubble? `brings` = files the fork changes relative to the bubble's
// representative (since their merge base), so history the fork carries from elsewhere counts too.
export function fits(bubble: Bubble, brings: string[]): boolean {
	return bubble.visible && brings.every((f) => !bubble.files.has(f));
}

// Visible, unlocked bubbles at distance 0 get set-joined. Returns [into, from] pairs in the order
// they must be applied; later pairs see the union produced by earlier ones.
export function zeroDistanceJoins(bubbles: Bubble[]): [string, string][] {
	const live = bubbles.filter((h) => h.visible && !h.locked).map((h) => ({ ...h, files: new Set(h.files) }));
	const joins: [string, string][] = [];
	for (let i = 0; i < live.length; i++) {
		for (let j = i + 1; j < live.length; ) {
			if (distance(live[i], live[j]) === 0) {
				joins.push([live[i].id, live[j].id]);
				for (const f of live[j].files) live[i].files.add(f);
				live.splice(j, 1);
			} else j++;
		}
	}
	return joins;
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

