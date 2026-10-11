// When this browser last looked at a repository's Memory tab, so new notes from agents stand out. Per
// viewer, so local storage; it starts at the first visit, not at the start of time.
const key = (repo: string) => `yorkle-memory-seen-${repo}`;

export function memorySeen(repo: string): number {
	try {
		const v = Number(localStorage.getItem(key(repo)));
		if (v) return v;
		localStorage.setItem(key(repo), String(Date.now()));
	} catch {
		// storage blocked: every note counts as seen
	}
	return Date.now();
}

export function markMemorySeen(repo: string) {
	try {
		localStorage.setItem(key(repo), String(Date.now()));
	} catch {
		// storage blocked
	}
}
