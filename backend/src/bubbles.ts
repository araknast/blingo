// Pure bubble rules from design.md. No I/O: RepoDO loads rows, asks these, writes results.

export type Bubble = { id: string; files: Set<string>; visible: boolean };

// |files(a) ∩ files(b)| — symmetric, so "distance from a to b" == "from b to a".
export function distance(a: Bubble, b: Bubble): number {
	let n = 0;
	for (const f of b.files) if (a.files.has(f)) n++;
	return n;
}

// First visible bubble none of whose files the fork touches, or null → fork starts a new bubble.
export function placeFork(bubbles: Bubble[], files: string[]): string | null {
	return bubbles.find((h) => h.visible && files.every((f) => !h.files.has(f)))?.id ?? null;
}

// Visible bubbles at distance 0 get set-joined. Returns [into, from] pairs in the order
// they must be applied; later pairs see the union produced by earlier ones.
export function zeroDistanceJoins(bubbles: Bubble[]): [string, string][] {
	const live = bubbles.filter((h) => h.visible).map((h) => ({ ...h, files: new Set(h.files) }));
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

// Nearest visible, non-conflicting neighbour of `id` (ties → earliest), or null.
export function nearestNeighbour(id: string, bubbles: Bubble[], conflicts: Set<string>): string | null {
	const self = bubbles.find((h) => h.id === id);
	if (!self) return null;
	let best: Bubble | null = null;
	let bestD = Infinity;
	for (const h of bubbles) {
		if (h.id === id || !h.visible || conflicts.has(conflictKey(id, h.id))) continue;
		const d = distance(self, h);
		if (d < bestD) [best, bestD] = [h, d];
	}
	return best?.id ?? null;
}

