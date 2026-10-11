// Locking and ferging bubbles, shared by the Overview's map and the Bubbles tab.
import { api } from "./session.svelte";
import { toast, toastError } from "./toast.svelte";
import type { RepoState } from "./types";
import { plural, short } from "./util";

export const bubbleName = (d: RepoState | null | undefined, id: string) => d?.bubbles.find((b) => b.id === id)?.name || short(id);

export async function setLock(repo: string, d: RepoState | null | undefined, id: string, lock: boolean) {
	try {
		await api("POST", `/repos/${repo}/${lock ? "lock" : "unlock"}`, { bubble: id });
		toast(lock ? `Locked ${bubbleName(d, id)}` : `Unlocked ${bubbleName(d, id)}`);
		return true;
	} catch (e) {
		toastError(e);
		return false;
	}
}

// The files both bubbles changed: what a ferge's locked bubble will hold.
export function fergeFiles(d: RepoState | null | undefined, a: string, b: string): string[] {
	const files = (id: string) => new Set(d?.bubbles.find((x) => x.id === id)?.members.flatMap((m) => m.files) ?? []);
	const fb = files(b);
	return [...files(a)].filter((f) => fb.has(f)).sort();
}

// Ferges a conflicting pair; returns the new locked bubble, or null if it failed.
export async function ferge(repo: string, d: RepoState | null | undefined, a: string, b: string): Promise<string | null> {
	try {
		const r = await api<{ locked: string; files: string[] }>("POST", `/repos/${repo}/ferge`, { a, b });
		toast(`Ferged. ${bubbleName(d, r.locked)} holds ${plural(r.files.length, "conflicting file")}.`);
		return r.locked;
	} catch (e) {
		toastError(e);
		return null;
	}
}
