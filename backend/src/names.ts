// Friendly names for repositories and bubbles. Pure: the caller passes the random source.

const ADJECTIVES = [
	"amber", "brisk", "calm", "clever", "cosy", "crisp", "dapper", "eager", "fancy", "gentle", "glossy", "jolly", "keen", "lively",
	"lucky", "mellow", "merry", "nimble", "plucky", "quiet", "rosy", "rustic", "snappy", "spry", "sunny", "swift", "tidy", "witty",
];
const NOUNS = [
	"badger", "beacon", "breeze", "comet", "cove", "falcon", "fern", "harbor", "heron", "lantern", "maple", "meadow", "otter", "pebble",
	"pine", "puffin", "quill", "river", "robin", "sparrow", "spruce", "tide", "thistle", "walrus", "willow", "wren",
];

// A bubble's name in parts: the first bubble of a repository is called after it (no adjective).
export type Name = { adj: string; noun: string };

export const nameText = (n: Name) => (n.adj ? `${n.adj} ${n.noun}` : n.noun);

// "adjective noun", e.g. "swift otter".
export function friendlyName(random: () => number = Math.random): Name {
	const pick = (xs: string[]) => xs[Math.floor(random() * xs.length) % xs.length];
	return { adj: pick(ADJECTIVES), noun: pick(NOUNS) };
}

// A ferge of bubbles a and b: "<adj a> <adj b> <noun a><noun b> ferge" (no space between the nouns;
// a missing adjective is left out).
export function fergeName(a: Name, b: Name): string {
	return [a.adj, b.adj, `${a.noun}${b.noun}`, "ferge"].filter(Boolean).join(" ");
}

// A repository name from the API: trimmed, 1–60 characters.
export function repoName(raw: unknown): string | null {
	const s = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
	return s && s.length <= 60 ? s : null;
}
