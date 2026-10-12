// @ts-nocheck -- Node APIs; this project only has Worker types.
// Runs the Box git scripts against local repos (needs bash and git ≥ 2.38 on the machine).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "vitest";
import { APPLY_SH, COMMIT_FILES_SH, CONFLICT, ENSURE_REP, FERGE_SH, MEMORY_HOOK_SH, MERGES, MERGE_SH, NO_CONFLICT, PATCH_SH, PUSH_SH, REP, STOP_HOOK_SH, UNBASED, readSeries } from "../src/git-scripts";

const T = mkdtempSync(`${tmpdir()}/blingo-git-`);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const CLONE = `${T}/rep`; // stands in for the bubble Box's clone at REP
const ID = { GIT_AUTHOR_NAME: "blingo", GIT_AUTHOR_EMAIL: "blingo@blingo", GIT_COMMITTER_NAME: "blingo", GIT_COMMITTER_EMAIL: "blingo@blingo" };

const run = (script: string, args: string[] = [], o: { stdin?: string; env?: Record<string, string> } = {}) => {
	const r = spawnSync("bash", ["-c", script.replaceAll(REP, CLONE), "sh", ...args], { cwd: T, input: o.stdin, env: { ...process.env, ...ID, ...o.env }, encoding: "utf8" });
	return { code: r.status, out: r.stdout, err: r.stderr };
};
const sh = (cmd: string, cwd = T, env: Record<string, string> = {}) => {
	const r = spawnSync("bash", ["-c", cmd], { cwd, env: { ...process.env, ...ID, ...env }, encoding: "utf8" });
	if (r.status) throw new Error(`${cmd}: ${r.stderr}`);
	return r.stdout.trim();
};
const onRep = (script: string, args: string[] = [], o = {}) => run(ENSURE_REP + script, [R, ...args], o);
const head = (bare: string) => sh(`git --git-dir=${bare} rev-parse main`);

// The base repo has a, b, c; R is a bubble's rep (a fork of it).
sh(`git init -q -b main w0 && cd w0 && printf 'a\\n' > a.txt && printf 'b\\n' > b.txt && printf 'c\\n' > c.txt && git add -A && git commit -qm base && git clone -q --bare . ../R.git`);
const R = `${T}/R.git`;
const bare = (name: string, edit: string) => (sh(`git clone -q w0 ${name} && cd ${name} && ${edit} && git clone -q --bare . ../${name}.git`), `${T}/${name}.git`);

// An agent's fork: clone R, remember where it started, commit, take its patch series.
const fork = (name: string, edit: string) => {
	sh(`git clone -q ${R} ${name}`);
	const start = sh("git rev-parse HEAD", `${T}/${name}`);
	sh(edit, `${T}/${name}`, { GIT_AUTHOR_NAME: "Bob", GIT_AUTHOR_EMAIL: "bob@example.com" });
	const p = run(PATCH_SH, [`${T}/${name}`, start]);
	expect(p.code, p.err).toBe(0);
	return readSeries(p.out);
};
const apply = (mbox: string, committer = "r-x-f-0") => run(ENSURE_REP + APPLY_SH, [R], { stdin: mbox, env: { GIT_COMMITTER_NAME: committer, GIT_COMMITTER_EMAIL: "agent@blingo.test" } });

test("patch series: changed files and format-patch mbox", () => {
	const s = fork("f0", `printf 'C\\n' > c.txt && git commit -qam "change c" && printf 'D\\n' > d.txt && git add d.txt && git commit -qm "add d"`);
	expect(s.files).toEqual(["c.txt", "d.txt"]);
	expect(s.mbox.match(/^Subject: \[PATCH \d\/2\]/gm)).toHaveLength(2);
});

test("series apply in order, authors kept, committer = fork id; a clashing series is left out whole", () => {
	const f1 = fork("f1", `printf 'B1\\n' > b.txt && git commit -qam "change b"`);
	const f2 = fork("f2", `printf 'D\\n' > d.txt && git add d.txt && git commit -qm "add d" && printf 'E\\n' > e.txt && git add e.txt && git commit -qm "add e"`);
	const f3 = fork("f3", `printf 'B3\\n' > b.txt && git commit -qam "clash on b"`);
	const before = head(R);
	expect([apply(f1.mbox, "r-x-f-1"), apply(f2.mbox, "r-x-f-2"), apply(f3.mbox, "r-x-f-3")].map((r) => r.code)).toEqual([0, 0, CONFLICT]);
	expect(sh("git status --porcelain", CLONE)).toBe("");
	expect(run(ENSURE_REP + PUSH_SH, [R]).code).toBe(0);
	expect(sh(`git --git-dir=${R} log --format='%an|%cn|%ce|%s' ${before}..main`).split("\n")).toEqual([
		"Bob|r-x-f-2|agent@blingo.test|add e",
		"Bob|r-x-f-2|agent@blingo.test|add d",
		"Bob|r-x-f-1|agent@blingo.test|change b",
	]);
});

test("neighbour merge: a disjoint rep merges in; a clashing one leaves the rep alone", () => {
	const ok = onRep(MERGE_SH, [bare("n1", `printf 'A2\\n' > a.txt && git commit -qam "n1 a"`), "merge bubble"]);
	expect(ok.code, ok.err).toBe(0);
	expect(ok.out).toContain("+A2");
	const before = head(R);
	expect(onRep(MERGE_SH, [bare("n2", `printf 'B9\\n' > b.txt && git commit -qam "n2 b"`), "merge bubble"]).code).toBe(CONFLICT);
	expect(head(R)).toBe(before);
	expect(sh("git status --porcelain", CLONE)).toBe("");
});

test("ferge in A's clone: A loses the conflicting files, L gets them with markers, the clone stays A", () => {
	sh(`git clone -q --bare ${R} L.git`);
	const r = onRep(FERGE_SH, [`${T}/n2.git`, `${T}/L.git`]);
	expect(r.code, r.err).toBe(0);
	const [files, tree] = r.out.split(/^==$/m).map((s) => s.split("\n").filter(Boolean));
	expect(files).toEqual(["b.txt"]);
	expect(tree).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
	expect(sh(`git --git-dir=${T}/L.git show main:b.txt`)).toContain("<<<<<<<");
	expect(sh(`git --git-dir=${R} ls-tree --name-only main`)).not.toContain("b.txt");
	expect(sh("git rev-parse HEAD", CLONE)).toBe(head(R));
	expect(onRep(FERGE_SH, [`${T}/n1.git`, `${T}/L.git`]).code).toBe(NO_CONFLICT);
	// later series still apply and push from there
	expect(apply(fork("f4", `printf 'F\\n' > f.txt && git add f.txt && git commit -qm "add f"`).mbox).code).toBe(0);
	expect(run(ENSURE_REP + PUSH_SH, [R]).code).toBe(0);
	expect(sh(`git --git-dir=${R} log -1 --format=%s main`)).toBe("add f");
});

test("a fresh clone (new container) picks up from what was pushed", () => {
	rmSync(CLONE, { recursive: true, force: true });
	expect(apply(fork("f5", `printf 'G\\n' > g.txt && git add g.txt && git commit -qm "add g"`).mbox).code).toBe(0);
	expect(run(ENSURE_REP + PUSH_SH, [R]).code).toBe(0);
	expect(sh(`git --git-dir=${R} log -1 --format=%s main`)).toBe("add g");
});

test("patch series edge cases: from the empty base repo, nothing committed, merge commits", () => {
	sh(`git init -q -b main e0 && cd e0 && printf 'x\\n' > x.txt && git add -A && git commit -qm root`);
	const root = readSeries(run(PATCH_SH, [`${T}/e0`, ""]).out);
	expect(root.files).toEqual(["x.txt"]);
	expect(root.mbox).toContain("Subject: [PATCH] root");
	sh("git init -q -b main e1");
	const none = run(PATCH_SH, [`${T}/e1`, ""]);
	expect([none.code, readSeries(none.out).files]).toEqual([0, []]);
	sh(`git clone -q ${R} m && cd m && git checkout -qb side && printf 'S\\n' > s.txt && git add s.txt && git commit -qm side && git checkout -q main && printf 'T\\n' > t.txt && git add t.txt && git commit -qm t && git merge -q --no-edit side`);
	expect(run(PATCH_SH, [`${T}/m`, head(R)]).code).toBe(MERGES);
	sh(`git clone -q ${R} u && cd u && git checkout -q --orphan fresh && git commit -qm unrelated && git branch -qM main && git clone -q --bare . ../ub`);
	expect(run(PATCH_SH, [`file://${T}/ub`, head(R)]).code).toBe(UNBASED);
});

test("commit files: a person's files committed and pushed; bad paths and no-ops refused", () => {
	const fork = bare("cf", "true");
	const files = { "a.txt": "resolved\n", "new/dir/n.txt": "n\n" };
	expect(run(COMMIT_FILES_SH, [fork, "Resolve ferge conflicts"], { stdin: JSON.stringify(files) }).code).toBe(0);
	expect(sh(`git --git-dir=${fork} log -1 --format=%s main`)).toBe("Resolve ferge conflicts");
	expect(sh(`git --git-dir=${fork} show main:a.txt`)).toBe("resolved");
	expect(sh(`git --git-dir=${fork} show main:new/dir/n.txt`)).toBe("n");
	const before = head(fork);
	for (const p of ["../x", "/etc/x", "a/../../x", ".git/config", ""]) {
		expect(run(COMMIT_FILES_SH, [fork, "x"], { stdin: JSON.stringify({ [p]: "x" }) }).code).not.toBe(0);
	}
	expect(run(COMMIT_FILES_SH, [fork, "x"], { stdin: JSON.stringify(files) }).code).not.toBe(0); // nothing changed
	expect(head(fork)).toBe(before);
});

test("memory hook: new items once, as PostToolBatch additional context", () => {
	sh("mkdir -p task");
	const hook = () => run(MEMORY_HOOK_SH, [`${T}/task`]);
	expect(hook()).toMatchObject({ code: 0, out: "" }); // nothing pushed yet
	sh("printf -- '- use pnpm\\n- tests live in t/\\n' > task/memory.md");
	const first = hook();
	expect(first.code).toBe(0);
	expect(JSON.parse(first.out)).toEqual({
		hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "Repository memory was updated. It now holds:\n- use pnpm\n- tests live in t/\n" },
	});
	expect(hook().out).toBe(""); // unchanged since
	sh("printf -- '- use pnpm\\n' > task/memory.md");
	expect(JSON.parse(hook().out).hookSpecificOutput.additionalContext).toContain("- use pnpm");
});

test("stop hook: blocks an agent's unsubmittable repo state (at most 3 times), and a missing plan", () => {
	let n = 0;
	// A fresh agent clone of R with `edit` applied; the hook's exit code and message.
	const stop = (edit: string, plan = "") => {
		const d = `${T}/sh${++n}`;
		sh(`mkdir -p ${d}/task && git clone -q ${R} ${d}/repo && git -C ${d}/repo rev-parse HEAD > ${d}/task/base`);
		sh(edit, `${d}/repo`);
		const r = () => run(STOP_HOOK_SH, [`${d}/task`, `${d}/repo`, plan]);
		return Object.assign(r(), { again: r });
	};
	expect(stop("printf 'n\\n' > n.txt && git add -A && git commit -qm n && printf 'u\\n' > u.txt").code).toBe(0);
	const merged = stop("git checkout -qb s && printf 's\\n' > s.txt && git add -A && git commit -qm s && git checkout -q main && printf 't\\n' > t.txt && git add -A && git commit -qm t && git merge -q --no-edit s");
	expect([merged.code, merged.err]).toEqual([2, expect.stringContaining("merge commits")]);
	const conflict = stop("git checkout -qb s && printf 'x\\n' > a.txt && git commit -qam s && git checkout -q main && printf 'y\\n' > a.txt && git commit -qam t && (git merge -q s 2>/dev/null || true)");
	expect(conflict.err).toContain("still in progress");
	expect(stop("git checkout -q --orphan o && git commit -qm o").err).toContain("no longer contains");
	expect(stop("git init -q sub && mkdir -p dep && git init -q dep/x").err).toMatch(/inside .*: dep\/x\/ sub\//);
	const linked = stop("git init -q sub && git -C sub commit -q --allow-empty -m s && git add sub 2>/dev/null");
	expect(linked.err).toContain(": sub -");
	expect([linked.again().code, linked.again().code, linked.again().code]).toEqual([2, 2, 0]); // then it may stop
	expect(stop("true", "http://127.0.0.1:1/plan").err).toContain("haven't written your plan");
	expect(stop("echo '[]' > ../task/tasks.json", "http://127.0.0.1:1/plan").code).toBe(0); // checker unreachable: let it stop
});
