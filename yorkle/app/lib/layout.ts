import type { Bubble, Member } from "./types";

export const MAX_DOTS = 60;
const ORDER = { rep: 0, conflict: 1, pending: 2, merged: 3 };

// Rep first (it sits in the middle), then the others, stable by name.
export const orderMembers = (ms: Member[]) =>
	[...ms].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));

export const fileCount = (b: Bubble) => new Set(b.members.flatMap((m) => m.files)).size;

// Area grows with the files a bubble holds, but there is always room for its fork dots.
export function radius(b: Bubble) {
	const dots = Math.min(b.members.length, MAX_DOTS);
	return Math.min(150, Math.max(34 + 7 * Math.sqrt(fileCount(b)), 13 * Math.sqrt(dots) + 18));
}

// Sunflower placement: dot i of n inside a circle of radius r.
export function dotOffset(i: number, n: number, r: number) {
	if (i === 0) return { x: 0, y: 0 };
	const step = Math.min(13, (r - 14) / Math.sqrt(Math.max(n - 1, 1)));
	const a = i * 2.399963;
	const d = step * Math.sqrt(i + 0.3);
	return { x: Math.cos(a) * d, y: Math.sin(a) * d };
}

// Point on the rim of a circle at (x, y) facing (tx, ty).
export function edge(x: number, y: number, r: number, tx: number, ty: number) {
	const d = Math.hypot(tx - x, ty - y) || 1;
	return { x: x + ((tx - x) / d) * r, y: y + ((ty - y) / d) * r };
}

// Small stable number from a name, to vary each bubble's film.
export const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
