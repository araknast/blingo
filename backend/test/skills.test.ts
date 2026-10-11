import { expect, test } from "vitest";
import { parseSkillUpload, resolveSkills } from "../src/skills";

const b64 = (s: string) => btoa(s);
const md = (fm: string) => b64(`---\n${fm}\n---\nbody`);
const ok = [
	{ path: "pdf/SKILL.md", data: md("name: pdf-tools\ndescription: \"Work with PDFs\"") },
	{ path: "pdf/scripts/a.py", data: b64("print(1)") },
];

test("a folder with a valid SKILL.md parses, relative to the folder", () => {
	expect(parseSkillUpload(ok)).toEqual({
		name: "pdf-tools",
		description: "Work with PDFs",
		files: [
			{ path: "SKILL.md", data: ok[0].data },
			{ path: "scripts/a.py", data: ok[1].data },
		],
	});
});

test("bad uploads are rejected", () => {
	const err = (x: unknown) => expect(parseSkillUpload(x)).toHaveProperty("error");
	err([]);
	err([{ path: "x/readme.md", data: b64("hi") }]); // no SKILL.md
	err([{ path: "x/SKILL.md", data: b64("no frontmatter") }]);
	err([{ path: "x/SKILL.md", data: md("name: Bad Name\ndescription: d") }]);
	err([{ path: "x/SKILL.md", data: md("name: ok") }]); // no description
	err([...ok, { path: "pdf/../evil", data: b64("x") }]);
	err([{ path: "x/SKILL.md", data: "not base64!" }]);
	err([{ path: "x/SKILL.md", data: md("name: a\ndescription: d") }, { path: "x/big", data: "A".repeat(1_400_000) }]);
});

test("resolveSkills: all by default, none for [], else exactly the named ones", () => {
	expect(resolveSkills(undefined, ["a", "b"])).toEqual(["a", "b"]);
	expect(resolveSkills([], ["a", "b"])).toEqual([]);
	expect(resolveSkills(["b", "b"], ["a", "b"])).toEqual(["b"]);
	expect(resolveSkills(["z"], ["a"])).toHaveProperty("error");
	expect(resolveSkills(["run:", " `b` "], ["run", "b"])).toEqual(["run", "b"]);
	expect(resolveSkills("a", ["a"])).toHaveProperty("error");
});
