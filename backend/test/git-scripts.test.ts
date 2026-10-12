// @ts-nocheck -- Node APIs; this project only has Worker types.
// Runs the Box git scripts against local repos (needs bash and git ≥ 2.38 on the machine).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, expect, test } from "vitest";
import { APPLY_SH, COMMIT_FILES_SH, CONFLICT, ENSURE_REP, ENV_MERGE_SH, ENV_PUSH_SH, ENV_SAVE_SH, FERGE_SH, MEMORY_HOOK_SH, MERGES, MERGE_SH, NO_CONFLICT, PATCH_SH, PUSH_SH, REP, readSeries } from "../src/git-scripts";

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

test("env: a run's overlay changes saved as an env commit, unchanged files never fetched, pushed", () => {
	// The fork's env: an old tool, an untouched lib, a dir the run replaces.
	sh(`git init -q -b env envw && cd envw && mkdir -p usr/bin usr/lib opt/gone && seq 400 > usr/bin/old && echo keep > usr/lib/keep && echo x > opt/gone/x && git add -A && git commit -qm env && git clone -q --bare . ../env.git && git --git-dir=../env.git config uploadpack.allowFilter true`);
	const G = `${T}/afs.git`; // as ArtifactFS clones it: blobless
	sh(`git clone -q --bare --filter=blob:none --branch env file://${T}/env.git ${G}`);
	// The run's upper dirs, and the merged view (the overlays) at W.
	const O = `${T}/ovl`;
	const W = `${T}/root`;
	sh(`mkdir -p ${O}/usr/u/bin ${O}/opt/u/gone ${O}/root/u/.claude ${O}/etc/u && cd ${O} && echo new > usr/u/bin/new && seq 401 > usr/u/bin/old && ln -s new usr/u/bin/link && seq 1100 > usr/u/big && chmod +x usr/u/big && echo y > opt/u/gone/y && echo s > root/u/.claude/session && echo h > etc/u/hosts`);
	sh(`mkdir -p ${W} && for d in usr opt root etc; do mkdir -p ${W}/$d && cp -a ${O}/$d/u/. ${W}/$d/; done`);
	const env = { ENV_GIT: G, ENV_ROOT: W, ENV_OVL: O, ENV_CHUNK: "2000", GIT_NO_LAZY_FETCH: "1" };
	const s = run(ENV_SAVE_SH, [], { env });
	expect(s.code, s.err).toBe(0);
	const tree = sh(`git --git-dir=${G} ls-tree -r refs/blingo/env`);
	const at = (p: string) => tree.split("\n").find((l) => l.endsWith(`\t${p}`))?.split(/\s+/);
	expect(sh(`git --git-dir=${G} show refs/blingo/env:usr/bin/old`)).toBe(sh("seq 401"));
	expect(sh(`git --git-dir=${G} show refs/blingo/env:usr/bin/new`)).toBe("new");
	expect(at("usr/bin/link")?.[0]).toBe("120000");
	expect(at("usr/lib/keep")?.[2]).toBe(sh(`git --git-dir=${T}/env.git rev-parse env:usr/lib/keep`)); // carried, not read
	expect(at("opt/gone/x")).toBeUndefined(); // hidden by the replaced dir
	expect(at("opt/gone/y")).toBeDefined();
	expect(at("usr/big")).toBeUndefined();
	expect(["000", "001", "002"].map((n) => at(`usr/big.blingo-part-${n}`)?.[0])).toEqual(["100755", "100755", "100755"]);
	expect(tree).not.toMatch(/root\/\.claude|etc\/hosts/);
	expect(sh(`git --git-dir=${G} rev-parse refs/blingo/env^`)).toBe(sh(`git --git-dir=${T}/env.git rev-parse env`)); // on the last env
	// Pushed without fetching anything; the fork's env has it all, and the chunks join back up.
	const p = run(ENV_PUSH_SH, [`file://${T}/env.git`], { env });
	expect(p.code, p.err).toBe(0);
	sh(`git clone -q --branch env ${T}/env.git envc`);
	expect(sh("cat usr/big.blingo-part-*", `${T}/envc`)).toBe(sh("seq 1100"));
	expect(sh("cat usr/lib/keep; tail -1 usr/bin/old", `${T}/envc`)).toBe("keep\n401");
});

test("env merge: members' envs merge into the rep's as their code lands", () => {
	const serve = (b: string) => sh(`git --git-dir=${b} config uploadpack.allowFilter true && git --git-dir=${b} config uploadpack.allowAnySHA1InWant true`);
	// The rep's env: apk's db, a tool, a binary file.
	sh(`git init -q -b env mw && cd mw && mkdir -p lib/apk/db usr/bin usr/share && printf 'P:base\\n\\n' > lib/apk/db/installed && echo jq > usr/bin/jq && printf 'x\\0base' > usr/share/x.bin && git add -A && git commit -qm env && git clone -q --bare . ../mrep.git`);
	const R = `${T}/mrep.git`;
	serve(R);
	// Two members forked from it (forks copy env); each installs a package and rewrites the binary; a removes jq.
	const member = (name: string, edit: string) => {
		sh(`git clone -q --bare ${R} ${name}.git && git clone -q -b env ${name}.git ${name}w && cd ${name}w && ${edit} && git add -A && git commit -qm env && git push -q origin env`);
		serve(`${T}/${name}.git`);
		return `file://${T}/${name}.git`;
	};
	const a = member("ma", `printf 'P:a\\n\\n' >> lib/apk/db/installed && echo a > usr/bin/a && printf 'x\\0a' > usr/share/x.bin && git rm -q usr/bin/jq`);
	const b = member("mb", `printf 'P:b\\n\\n' >> lib/apk/db/installed && echo b > usr/bin/b && printf 'x\\0b' > usr/share/x.bin`);
	const env = (p: string) => sh(`git --git-dir=${R} show env:${p}`);
	const merge = (...src: string[]) => run(ENV_MERGE_SH, [`file://${R}`, ...src]);
	let m = merge(a);
	expect(m.code, m.err).toBe(0);
	expect(sh(`git --git-dir=${R} rev-parse env`)).toBe(sh(`git --git-dir=${T}/ma.git rev-parse env`)); // fast-forward
	m = merge(b);
	expect(m.code, m.err).toBe(0);
	expect(env("lib/apk/db/installed")).toBe("P:base\n\nP:a\n\nP:b"); // text: both sides kept
	expect(sh(`git --git-dir=${R} cat-file -p env:usr/share/x.bin | tr '\\0' _`)).toBe("x_b"); // binary: incoming wins
	expect(env("usr/bin/a")).toBe("a");
	expect(env("usr/bin/b")).toBe("b");
	expect(() => env("usr/bin/jq")).toThrow(); // a's removal kept
	expect(sh(`git --git-dir=${R} rev-list --parents -1 env`).split(" ")).toHaveLength(3);
	const head = sh(`git --git-dir=${R} rev-parse env`);
	sh(`git init -q --bare noenv.git && git clone -q ${R} noenvw && cd noenvw && git push -q ../noenv.git HEAD:refs/heads/main 2>/dev/null || git --git-dir=../noenv.git symbolic-ref HEAD refs/heads/main`);
	m = merge(b, `file://${T}/noenv.git`); // already merged; no env at all
	expect(m.code, m.err).toBe(0);
	expect(sh(`git --git-dir=${R} rev-parse env`)).toBe(head);
	// A rep without an env takes the source's.
	sh(`git init -q --bare -b main bare.git && git --git-dir=bare.git symbolic-ref HEAD refs/heads/main`);
	sh(`cd mw && git push -q ../bare.git env:refs/heads/main`);
	serve(`${T}/bare.git`);
	m = run(ENV_MERGE_SH, [`file://${T}/bare.git`, b]);
	expect(m.code, m.err).toBe(0);
	expect(sh(`git --git-dir=${T}/bare.git rev-parse env`)).toBe(sh(`git --git-dir=${T}/mb.git rev-parse env`));
});

test("env: with no env git dir (the mount failed), nothing is saved or pushed", () => {
	const env = { ENV_GIT: `${T}/missing.git` };
	expect(run(ENV_SAVE_SH, [], { env }).code).toBe(0);
	expect(run(ENV_PUSH_SH, [`${T}/env.git`], { env }).code).toBe(0);
	expect(sh(`git --git-dir=${T}/env.git for-each-ref refs/blingo`)).toBe("");
});
