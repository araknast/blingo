import { expect, test } from "vitest";
import { demoAnchors, demoSteps } from "./demo";
import { radius } from "./layout";

// The splash loops by wrapping around, so every bubble and pill must have a fixed spot, and no two may
// ever overlap (each bubble at the largest it gets; labels sit up to 34 below a bubble).
test("every demo bubble and agent has an anchor, with room for its largest size", () => {
	const r = new Map<string, number>();
	for (const s of demoSteps) for (const b of s.bubbles) r.set(b.id, Math.max(r.get(b.id) ?? 0, radius(b)));
	const pills = new Set(demoSteps.flatMap((s) => [...s.agents.map((a) => a.fork), ...s.waiting, ...s.placing]));
	for (const id of [...r.keys(), ...pills]) expect(demoAnchors[id], id).toBeDefined();
	const at = (id: string) => demoAnchors[id];
	const ids = [...r.keys()];
	for (const a of ids) for (const b of ids) if (a < b) expect(Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y), `${a} ${b}`).toBeGreaterThan(r.get(a)! + r.get(b)! + 34);
	// A pill is 168×30; it must clear every bubble's circle and label.
	for (const p of pills)
		for (const id of ids) {
			const dx = Math.max(0, Math.abs(at(p).x - at(id).x) - 84), dy = Math.max(0, Math.abs(at(p).y - at(id).y) - 15);
			expect(Math.hypot(dx, dy), `${p} ${id}`).toBeGreaterThan(r.get(id)! + 10);
		}
});
