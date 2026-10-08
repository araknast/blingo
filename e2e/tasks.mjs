// End-to-end test of tasks, superagents and memory against a deployed blingo (real agents: costs
// a few Claude runs). Creates two repositories and deletes them at the end.
// usage: BLINGO_URL=https://blingo.<subdomain>.workers.dev BLINGO_TOKEN=… node e2e/tasks.mjs [repo2]
//        (repo2 = only the superagent / dependency / ferge part)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const U = process.env.BLINGO_URL;
const T = process.env.BLINGO_TOKEN;
if (!U || !T) throw new Error("set BLINGO_URL and BLINGO_TOKEN");
const t0 = Date.now();
const log = (...a) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`, ...a);
const fails = [];
const check = (ok, what) => {
	log(ok ? "PASS" : "FAIL", what);
	if (!ok) fails.push(what);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
	for (let i = 0; ; i++) {
		const r = await fetch(U + path, { method, headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
		const text = await r.text();
		if (r.status === 503 && i < 5) {
			await sleep(2000);
			continue;
		}
		try {
			return { status: r.status, ...JSON.parse(text) };
		} catch {
			return { status: r.status, text };
		}
	}
}
const st = (R) => call("GET", `/repos/${R}`);
async function waitFor(what, fn, ms, every = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const v = await fn();
		if (v) return v;
		await sleep(every);
	}
	log("TIMEOUT waiting for", what);
	return null;
}
const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@x", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@x" } }).toString();
// Clone a notagent fork, write files, commit with `msg`, push. Returns the clone dir.
function push(n, files, msg) {
	const url = n.clone.split(" ")[2];
	const d = join(mkdtempSync(join(tmpdir(), "e2e-")), "c");
	git(["clone", "-q", url, d]);
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(dirname(join(d, p)), { recursive: true });
		writeFileSync(join(d, p), c);
	}
	git(["add", "-A"], d);
	git(["commit", "-qm", msg], d);
	git(["push", "-q", url, "HEAD:main"], d);
	return d;
}
const task = (s, id) => s.tasks.find((t) => t.id === id);
const fileOf = async (R, fork, path) => {
	const r = await fetch(`${U}/repos/${R}/${fork}?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${T}` } });
	return r.ok ? await r.text() : `(${r.status})`;
};
const repos = [];

// ---------------- repo 1: memory, notagent task, agent task + memory ----------------
async function repo1() {
	const { repo: R } = await call("POST", "/repos");
	repos.push(R);
	log("repo1", R);

	check((await call("POST", `/repos/${R}/memory`, { text: "temp note" })).status === 201, "memory: add");
	const mid = (await st(R)).memory[0]?.id;
	check((await call("DELETE", `/repos/${R}/memory/${mid}`)).status === 200 && (await st(R)).memory.length === 0, "memory: delete");
	check((await call("DELETE", `/repos/${R}/memory/${mid}`)).status === 404, "memory: delete missing → 404");
	check((await call("POST", `/repos/${R}/memory`, { text: "" })).status === 400, "memory: empty → 400");

	check((await call("POST", "/notagents", { repo: R })).status === 400, "notagent: description required");
	const n = await call("POST", "/notagents", { repo: R, description: "add notes file" });
	check(n.status === 201 && n.task && n.fork, "notagent: creates task + fork");
	check(task(await st(R), n.task)?.status === "in-progress", "notagent: task in-progress after take");
	push(n, { "notes.txt": "one\n" }, "Add notes.txt with a first line\n\nSo later tasks have a file to extend.");
	const done = await waitFor("notagent task completed", async () => {
		const t = task(await st(R), n.task);
		return t?.status === "completed" && t;
	}, 5 * 60_000);
	check(!!done, "notagent: task completed on placement");
	check(done?.explanation?.startsWith("Add notes.txt with a first line") && done.explanation.includes("So later tasks"), `notagent: explanation from commits (${JSON.stringify(done?.explanation)})`);
	check((await call("POST", `/repos/${R}/tasks/${n.task}/take`)).status === 409, "take completed task → 409");
	check((await call("POST", `/repos/${R}/tasks/${n.task}/retry`)).status === 409, "retry non-failed task → 409");

	// Agent that leaves a memory note.
	const a = await call("POST", "/agents", {
		repo: R,
		title: "Add hello.txt",
		prompt: "Create hello.txt containing the single line: hello. Then append exactly this line to /workspace/task/memory: e2e-memory: hello.txt holds the greeting",
	});
	check(a.status === 202 && a.task && a.fork, `agent: task started (${a.status} ${a.fork})`);
	check(task(await st(R), a.task)?.title === "Add hello.txt", "agent: task has its title");
	const at = await waitFor("agent task done", async () => {
		const t = task(await st(R), a.task);
		return (t?.status === "completed" || t?.status === "failed") && t;
	}, 20 * 60_000, 15_000);
	check(at?.status === "completed", `agent: task completed (${at?.status})`);
	log("agent explanation:", JSON.stringify(at?.explanation));
	check(!!at?.explanation, "agent: has explanation");
	let s = await st(R);
	const run = s.agents.find((x) => x.fork === a.fork);
	check(run?.status === "placed", `agent: run placed (${run?.status})`);
	if (run?.status !== "placed") log("agent log:", run?.log);
	const mem = s.memory.find((m) => m.text.includes("e2e-memory"));
	check(!!mem && mem.author === a.fork, `agent: wrote memory item (${JSON.stringify(s.memory)})`);
	check((await fileOf(R, a.fork, "hello.txt")).trim() === "hello", "agent: hello.txt landed");

	// A second agent must see that note in its system prompt.
	const b = await call("POST", "/agents", {
		repo: R,
		prompt: "Your system prompt contains a section 'Notes from earlier agents on this repository'. Copy every note line from it, verbatim, into memory-check.txt. Do not write anything to /workspace/task/memory.",
	});
	const bt = await waitFor("agent 2 done", async () => {
		const t = task(await st(R), b.task);
		return (t?.status === "completed" || t?.status === "failed") && t;
	}, 20 * 60_000, 15_000);
	check(bt?.status === "completed", `agent 2: completed (${bt?.status})`);
	const seen = await fileOf(R, b.fork, "memory-check.txt");
	log("memory-check.txt:", JSON.stringify(seen));
	check(seen.includes("e2e-memory: hello.txt holds the greeting"), "agent 2: memory item was in its system prompt");
}

// ---------------- repo 2: superagent plan, dependency scheduling, ferge debt ----------------
async function repo2() {
	const prompt = `Plan exactly these five tasks, in this order, no more and no fewer, using exactly these keys, titles, kinds, deps and descriptions:
- key "d", title "Create d.txt", kind "agent", deps []: "Create d.txt containing the single line: one"
- key "e", title "Append to d.txt", kind "agent", deps ["d"]: "Append the line two to d.txt. Change no other file."
- key "a", title "Write x.txt A", kind "notagent", deps []: "A human writes x.txt (version A)"
- key "b", title "Write x.txt B", kind "notagent", deps []: "A human writes x.txt (version B)"
- key "c", title "Follow up on x.txt", kind "notagent", deps ["a", "b"]: "A human follows up on x.txt after a and b"`;
	const sa = await call("POST", "/superagents", { prompt });
	check(sa.status === 202 && sa.repo && sa.superagent?.includes("-s-"), `superagent: started (${sa.status} ${sa.superagent})`);
	const R = sa.repo;
	repos.push(R);
	log("repo2", R);
	let s = await waitFor("superagent plan", async () => {
		const s = await st(R);
		const run = s.agents.find((x) => x.fork === sa.superagent);
		if (run && run.status !== "running") return s;
	}, 15 * 60_000, 10_000);
	const run = s?.agents.find((x) => x.fork === sa.superagent);
	check(run?.status === "planned", `superagent: run planned (${run?.status})`);
	if (run?.status !== "planned") {
		log("superagent log:", run?.log);
		return;
	}
	const by = (prefix) => s.tasks.find((t) => t.description.startsWith(prefix));
	const T_ = { d: by("Create d.txt"), e: by("Append the line two"), a: by("A human writes x.txt (version A)"), b: by("A human writes x.txt (version B)"), c: by("A human follows up") };
	check(s.tasks.length === 5 && Object.values(T_).every(Boolean), `superagent: 5 tasks (${s.tasks.map((t) => t.description).join(" | ")})`);
	if (!Object.values(T_).every(Boolean)) return;
	const id = Object.fromEntries(Object.entries(T_).map(([k, t]) => [k, t.id]));
	check(T_.e.deps.join() === id.d && [...T_.c.deps].sort().join() === [id.a, id.b].sort().join(), "superagent: deps mapped to task ids");
	check(s.tasks.every((t) => t.superagent === sa.superagent), "superagent: tasks record their superagent");
	check(T_.d.kind === "agent" && T_.a.kind === "notagent", "superagent: kinds kept");
	check(s.tasks.every((t) => t.title && t.title.length <= 60), `superagent: short titles (${s.tasks.map((t) => t.title).join(" | ")})`);
	check(s.tasks.map((t) => t.id).join() === [T_.d, T_.e, T_.a, T_.b, T_.c].map((t) => t.id).join(), "superagent: tasks listed in plan order");
	check(!T_.e.ready && !T_.c.ready, "e and c not ready at creation");

	// Watch invariants the whole time.
	let watching = true;
	const violations = [];
	let eStart = null;
	let unlocked = false;
	let lockedId = null;
	const watcher = (async () => {
		while (watching) {
			const s = await st(R);
			const t = (k) => task(s, id[k]);
			if (t("e") && t("e").status !== "open" && !eStart) {
				const d = t("d");
				const df = s.bubbles.flatMap((b) => b.members).find((m) => m.name === d?.fork);
				eStart = { bubble: t("e").bubble, dStatus: d?.status, dFork: df && { bubble: df.bubble, status: df.status }, bubbles: s.bubbles.map((b) => b.id) };
				log("e started:", JSON.stringify(eStart));
			}
			if (t("e")?.status !== "open" && t("d")?.status !== "completed") violations.push("e started before d completed");
			if ((t("c")?.ready || t("c")?.status !== "open") && !unlocked) violations.push(`c ready/started before unlock (bubbles ${s.bubbles.map((b) => b.id.slice(-8)).join(",")})`);
			if (unlocked && lockedId && (t("c")?.ready || t("c")?.status !== "open") && s.bubbles.some((b) => b.id === lockedId)) {
				// c may only be ready once the ferge bubble has been merged into the bubble it owes
				violations.push("c ready while the ferge bubble still exists separately");
			}
			await sleep(3000);
		}
	})();

	// a and b write x.txt differently from the same base → their bubbles conflict.
	const ta = await call("POST", `/repos/${R}/tasks/${id.a}/take`);
	check(ta.status === 201 && ta.fork, "take a");
	const tb = await call("POST", `/repos/${R}/tasks/${id.b}/take`);
	check(tb.status === 201 && tb.fork, "take b");
	check((await call("POST", `/repos/${R}/tasks/${id.c}/take`)).status === 409, "take c while waiting → 409");
	push(ta, { "x.txt": "version A\n" }, "Write x.txt version A");
	await waitFor("a completed", async () => task(await st(R), id.a)?.status === "completed", 5 * 60_000);
	push(tb, { "x.txt": "version B\n" }, "Write x.txt version B");
	await waitFor("b completed", async () => task(await st(R), id.b)?.status === "completed", 5 * 60_000);

	s = await waitFor("a/b conflict", async () => {
		const s = await st(R);
		const fa = s.bubbles.find((b) => b.members.some((m) => m.name === ta.fork));
		const fb = s.bubbles.find((b) => b.members.some((m) => m.name === tb.fork));
		if (fa && fb && fa.id !== fb.id && s.conflicts.some(([x, y]) => [x, y].sort().join() === [fa.id, fb.id].sort().join())) return { s, A: fa.id, B: fb.id };
	}, 10 * 60_000);
	check(!!s, "a's and b's bubbles marked conflicting");
	if (!s) return;
	check(!task(s.s, id.c).ready, "c waits while a and b are in conflicting bubbles");

	// Wait for e's agent chain to finish too, so merges are quiet before the ferge.
	const e = await waitFor("e done", async () => {
		const t = task(await st(R), id.e);
		return (t?.status === "completed" || t?.status === "failed") && t;
	}, 25 * 60_000, 15_000);
	check(e?.status === "completed", `e completed (${e?.status})`);
	check(!!eStart && eStart.dStatus === "completed" && eStart.dFork && ["merged", "rep"].includes(eStart.dFork.status) && eStart.dFork.bubble === eStart.bubble, `e started from the bubble holding d merged (${JSON.stringify(eStart)})`);
	const d = task(await st(R), id.d);
	const dtxt = await fileOf(R, e.fork, "d.txt");
	check(dtxt.trim() === "one\ntwo", `e saw d's work: d.txt = ${JSON.stringify(dtxt)}`);

	// Re-read the conflicting pair (merges may have renamed bubbles) and ferge it; retry while a
	// merge has one of them hidden.
	const fg = await waitFor("ferge", async () => {
		const s = await st(R);
		const fa = s.bubbles.find((b) => b.members.some((m) => m.name === ta.fork)).id;
		const fb = s.bubbles.find((b) => b.members.some((m) => m.name === tb.fork)).id;
		const r = await call("POST", `/repos/${R}/ferge`, { a: fa, b: fb });
		if (r.status !== 200) log("ferge not yet:", r.error);
		return r.status === 200 && r;
	}, 5 * 60_000, 10_000);
	check(!!fg?.locked, `ferge (${JSON.stringify(fg)})`);
	if (!fg) return;
	lockedId = fg.locked;
	await sleep(15_000);
	s = await st(R);
	check(!task(s, id.c).ready && task(s, id.c).status === "open", "c still waits after the ferge (owed)");
	check((await call("POST", `/repos/${R}/tasks/${id.c}/take`)).status === 409, "take c after ferge → 409");

	// Fix the conflict in a fork of the ferge bubble, then unlock it.
	const fx = await call("POST", "/notagents", { repo: R, bubble: fg.locked, description: "resolve x.txt" });
	push(fx, { "x.txt": "version A+B\n" }, "Resolve x.txt");
	await waitFor("fix completed", async () => task(await st(R), fx.task)?.status === "completed", 5 * 60_000);
	await sleep(15_000);
	check(!task(await st(R), id.c).ready, "c still waits while the ferge bubble is locked");
	unlocked = true;
	check((await call("POST", `/repos/${R}/unlock`, { bubble: fg.locked })).status === 200, "unlock ferge bubble");
	s = await waitFor("c ready", async () => {
		const s = await st(R);
		return task(s, id.c)?.ready && s;
	}, 15 * 60_000);
	check(!!s, "c becomes ready after the ferge bubble merges back");
	if (s) {
		check(!s.bubbles.some((b) => b.id === fg.locked) || s.bubbles.find((b) => b.id === fg.locked).members.some((m) => m.name === ta.fork), "ferge bubble absorbed with a's work");
		const tc = await call("POST", `/repos/${R}/tasks/${id.c}/take`);
		check(tc.status === 201 && tc.fork, "take c");
		const dir = join(mkdtempSync(join(tmpdir(), "e2e-")), "c");
		git(["clone", "-q", tc.clone.split(" ")[2], dir]);
		const x = readFileSync(join(dir, "x.txt"), "utf8");
		log("c's x.txt:", JSON.stringify(x));
		check(x.length > 0, "c's fork has x.txt back from the ferge bubble");
		check(readFileSync(join(dir, "d.txt"), "utf8").trim() === "one\ntwo", "c's fork has d and e's work");
	}
	watching = false;
	await watcher;
	check(violations.length === 0, `scheduling invariants held (${[...new Set(violations)].join("; ")})`);
}

try {
	await Promise.all([(process.argv[2] === "repo2" ? Promise.resolve() : repo1()).catch((e) => check(false, `repo1 crashed: ${e.stack}`)), repo2().catch((e) => check(false, `repo2 crashed: ${e.stack}`))]);
} finally {
	for (const R of repos) log("cleanup", R, (await call("DELETE", `/repos/${R}`)).deleted?.length, "repos deleted");
	log(fails.length ? `FAILURES (${fails.length}):\n- ${fails.join("\n- ")}` : "ALL PASSED");
}
