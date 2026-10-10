// Pure rules for a repository's skills (Claude Code skill folders). No I/O: RepoDO stores them.

// One uploaded file: path relative to the picked folder, contents as base64.
export type SkillFile = { path: string; data: string };
export type Skill = { name: string; description: string; files: SkillFile[] };

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 1_000_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// SKILL.md's `name` and `description` from its YAML frontmatter (plain `key: value` lines, optionally quoted).
export function frontmatter(md: string): Record<string, string> | null {
	const m = md.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!m) return null;
	const out: Record<string, string> = {};
	for (const line of m[1].split(/\r?\n/)) {
		const kv = line.match(/^([\w-]+):\s*(.*)$/);
		if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
	}
	return out;
}

// Checks an uploaded folder: files {path, data}, the paths starting with the folder's own name.
// The skill's files are returned relative to that folder (SKILL.md at the root).
export function parseSkillUpload(raw: unknown): Skill | { error: string } {
	if (!Array.isArray(raw) || !raw.length) return { error: "files must be a non-empty array" };
	if (raw.length > MAX_SKILL_FILES) return { error: `a skill has at most ${MAX_SKILL_FILES} files` };
	const all: SkillFile[] = [];
	for (const f of raw as Record<string, unknown>[]) {
		if (typeof f?.path !== "string" || typeof f.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) return { error: "every file needs a path and base64 data" };
		all.push({ path: f.path.replace(/^\.?\//, ""), data: f.data });
	}
	// Drop the picked folder's own name (webkitRelativePath is "folder/…").
	const top = all[0].path.split("/")[0];
	const files = all.every((f) => f.path.startsWith(`${top}/`)) ? all.map((f) => ({ ...f, path: f.path.slice(top.length + 1) })) : all;
	let bytes = 0;
	for (const f of files) {
		if (!f.path || f.path.startsWith("/") || f.path.split("/").some((s) => s === ".." || s === "." || s === "")) return { error: `bad file path: ${f.path || "(empty)"}` };
		bytes += (f.data.length * 3) / 4;
	}
	if (bytes > MAX_SKILL_BYTES) return { error: `a skill is at most ${MAX_SKILL_BYTES / 1_000_000} MB` };
	if (new Set(files.map((f) => f.path)).size !== files.length) return { error: "duplicate file paths" };
	const md = files.find((f) => f.path === "SKILL.md");
	if (!md) return { error: "the folder has no SKILL.md at its top level" };
	const fm = frontmatter(new TextDecoder().decode(Uint8Array.from(atob(md.data), (c) => c.charCodeAt(0))));
	if (!fm) return { error: "SKILL.md has no frontmatter (--- name: … description: … ---)" };
	if (!NAME.test(fm.name ?? "")) return { error: "SKILL.md name must be lowercase letters, digits and hyphens (at most 64)" };
	if (!fm.description || fm.description.length > 1024) return { error: "SKILL.md needs a description of at most 1024 characters" };
	return { name: fm.name, description: fm.description, files };
}

// The skills to load: undefined = all of the repository's (the default), [] = none, else exactly those.
export function resolveSkills(requested: unknown, available: string[]): string[] | { error: string } {
	if (requested === undefined || requested === null) return available;
	if (!Array.isArray(requested) || requested.some((s) => typeof s !== "string")) return { error: "skills must be a list of skill names" };
	const unknown = requested.find((s) => !available.includes(s));
	return unknown ? { error: `no such skill: ${unknown}` } : [...new Set(requested as string[])];
}
