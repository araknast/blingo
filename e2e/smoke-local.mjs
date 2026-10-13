// API smoke test against `wrangler dev --enable-containers=false` (no agents run; Artifacts is
// remote, so it creates one real repository and deletes it at the end).
// usage: (cd backend && npx wrangler dev --port 8799 --enable-containers=false) &
//        node e2e/smoke-local.mjs        # BLINGO_URL (default http://localhost:8799), BLINGO_TOKEN (default: backend/.dev.vars)
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const U = process.env.BLINGO_URL ?? "http://localhost:8799";
const T = process.env.BLINGO_TOKEN ?? readFileSync(join(root, "backend/.dev.vars"), "utf8").match(/^BLINGO_TOKEN=["']?([^"'\n]+)/m)[1];
const fails = [];
const check = (ok, what) => {
	console.log(ok ? "PASS" : "FAIL", what);
	if (!ok) fails.push(what);
};
const call = async (method, path, body) => {
	const r = await fetch(U + path, { method, headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
	const text = await r.text();
	try {
		return { status: r.status, ...JSON.parse(text) };
	} catch {
		return { status: r.status, text };
	}
};
const state = (R) => call("GET", `/repos/${R}`);
const task = async (R, id) => (await state(R)).tasks.find((t) => t.id === id);

const { repo: R } = await call("POST", "/repos");
console.log("repo", R);
try {
	// memory
	check((await call("POST", `/repos/${R}/memory`, { text: "use tabs" })).status === 201, "memory: add");
	const mid = (await state(R)).memory[0].id;
	check((await call("DELETE", `/repos/${R}/memory/${mid}`)).status === 200 && (await state(R)).memory.length === 0, "memory: delete");

	// skills: a folder upload with SKILL.md; tasks may name some; deleting one drops it from tasks
	const b64 = (x) => Buffer.from(x).toString("base64");
	const folder = (name, fm) => [
		{ path: `${name}/SKILL.md`, data: b64(`---\n${fm}\n---\nDo the thing.`) },
		{ path: `${name}/scripts/run.sh`, data: b64("echo hi") },
	];
	check((await call("POST", `/repos/${R}/skills`, { files: [{ path: "x/readme.md", data: b64("hi") }] })).status === 400, "skills: no SKILL.md → 400");
	check((await call("POST", `/repos/${R}/skills`, { files: folder("pdf", "name: pdf-tools\ndescription: Work with PDFs") })).status === 201, "skills: upload");
	check((await call("POST", `/repos/${R}/skills`, { files: folder("q", "name: quick\ndescription: Quick things") })).status === 201, "skills: second upload");
	check((await state(R)).skills.map((s) => s.name).join() === "pdf-tools,quick", "skills: listed");
	const sk = await call("POST", `/repos/${R}/tasks`, { title: "S", kind: "agent", skills: ["pdf-tools"] });
	check(sk.status === 201 && (await task(R, sk.task)).skills?.join() === "pdf-tools", "skills: a task names some");
	check((await call("POST", `/repos/${R}/tasks`, { title: "S", kind: "notagent", skills: ["nope"] })).status === 400, "skills: unknown skill → 400");
	check((await call("DELETE", `/repos/${R}/skills/pdf-tools`)).status === 200 && (await task(R, sk.task)).skills.length === 0, "skills: delete drops it from tasks");
	check((await call("DELETE", `/repos/${R}/skills/pdf-tools`)).status === 404, "skills: delete unknown → 404");

	// deployments: configured in settings, credentials stored apart, started by hand on a bubble
	const dep = { name: "prod", command: "echo ship", hosts: ["api.example.com"], auth: [{ host: "api.example.com", header: "Authorization", value: "Bearer s3cret" }] };
	check((await call("PUT", `/repos/${R}/settings`, { deploys: [{ ...dep, auth: [{ host: "other.example.org", header: "X", value: "v" }] }] })).status === 400, "deploys: auth host must be one of its hosts");
	const saved = await call("PUT", `/repos/${R}/settings`, { deploys: [dep] });
	check(saved.status === 200 && saved.deploys[0].auth[0].hasValue === true && !JSON.stringify(saved).includes("s3cret"), "deploys: saved; the credential is not returned");
	const kept = await call("PUT", `/repos/${R}/settings`, { deploys: [{ ...dep, auth: [{ host: "api.example.com", header: "Authorization" }] }] });
	check(kept.deploys[0].auth[0].hasValue === true, "deploys: a credential is kept when no value is sent");
	check((await call("POST", `/repos/${R}/deploys`, { name: "nope", bubble: "x" })).status === 409, "deploys: unknown deployment → 409");
	check((await call("POST", `/repos/${R}/deploys`, { name: "prod", bubble: "x" })).error === "no such bubble", "deploys: unknown bubble → 409");
	check((await call("POST", `/repos/${R}/deploys`, { name: "prod" })).status === 400, "deploys: bubble required");
	check((await call("PUT", `/repos/${R}/settings`, { deploys: [] })).deploys.length === 0, "deploys: removed");

	// notagents: description required; title given or defaulted
	check((await call("POST", "/notagents", { repo: R })).status === 400, "notagent: description required");
	// agents and superagents run only on the repository's own key
	check((await call("POST", "/agents", { repo: R, prompt: "x" })).status === 400, "agent: no key → 400");
	check((await call("POST", "/agents", { repo: R, prompt: "x", model: "not a model!" })).error === "model must be a model id", "agent: bad model → 400");
	check((await call("POST", "/agents", { prompt: "x" })).status === 400, "agent: new repo (no key) → 400");
	check((await call("POST", "/superagents", { repo: R, prompt: "x" })).status === 400, "superagent: no key → 400");
	const n1 = await call("POST", "/notagents", { repo: R, title: "Add hello", description: "Add hello.txt\n\nwith a greeting" });
	check(n1.status === 201 && (await task(R, n1.task))?.title === "Add hello", "notagent: title stored");
	check((await task(R, n1.task))?.status === "in-progress", "notagent: in-progress once taken");
	const n2 = await call("POST", "/notagents", { repo: R, description: "Fix the login redirect so users land back on the page they came from after signing in" });
	const t2 = await task(R, n2.task);
	check(t2?.title === "Fix the login redirect so users land back on the page they…" && t2.title.length <= 60, `notagent: title defaults from description (${JSON.stringify(t2?.title)})`);

	// POST /repos/:r/tasks
	check((await call("POST", `/repos/${R}/tasks`, { description: "x", kind: "agent" })).status === 400, "tasks: title required");
	check((await call("POST", `/repos/${R}/tasks`, { title: "x", kind: "robot" })).status === 400, "tasks: bad kind → 400");
	check((await call("POST", `/repos/${R}/tasks`, { title: "x", kind: "notagent", deps: ["t-nope"] })).status === 400, "tasks: unknown dep → 400");
	check((await call("POST", `/repos/${R}/tasks`, { title: "x", kind: "notagent", bubble: "nope" })).status === 404, "tasks: unknown bubble → 404");
	const h = await call("POST", `/repos/${R}/tasks`, { title: "Review hello", description: "Check **hello.txt**", kind: "notagent", deps: [n1.task] });
	check(h.status === 201 && h.task, "tasks: human task with a dep on an existing task");
	const ht = await task(R, h.task);
	check(ht?.status === "open" && !ht.ready && ht.deps.join() === n1.task, "tasks: it waits for its dep (open, not ready)");
	check((await call("POST", `/repos/${R}/tasks/${h.task}/take`)).status === 409, "tasks: can't take it yet");
	const free = await call("POST", `/repos/${R}/tasks`, { title: "Write docs", kind: "notagent" });
	const ft = await task(R, free.task);
	check(ft?.ready && ft.description === "Write docs", "tasks: no deps → ready; description defaults to the title");
	const tk = await call("POST", `/repos/${R}/tasks/${free.task}/take`);
	check(tk.status === 201 && tk.fork && tk.clone, "tasks: take a ready human task");

	// a notagent that hasn't been pushed to can be closed: it takes no more pushes and its task reads
	// failed; opening it again puts the task back to in-progress
	check((await call("POST", `/repos/${R}/forks/${tk.fork}/close`)).status === 202, "notagent: close");
	let st2 = await state(R);
	check(st2.closed.includes(tk.fork) && !st2.waiting.includes(tk.fork), "notagent: closed, no longer waiting");
	check((await task(R, free.task))?.status === "failed", "notagent: closing it fails its task");
	check((await call("POST", `/repos/${R}/forks/${tk.fork}/close`)).status === 409, "notagent: close again → 409");
	check((await call("POST", `/repos/${R}/forks/${tk.fork}/token`)).status === 409, "notagent: no push token while closed");
	check((await call("POST", `/repos/${R}/tasks/${free.task}/retry`)).status === 409, "notagent: retry a closed one → 409");
	check((await call("POST", `/repos/${R}/forks/nope-f-x/close`)).status === 409, "notagent: close an unknown fork → 409");
	check((await call("POST", `/repos/${R}/forks/${tk.fork}/open`)).status === 202, "notagent: open");
	st2 = await state(R);
	check(!st2.closed.includes(tk.fork) && st2.waiting.includes(tk.fork), "notagent: open, waiting again");
	check((await task(R, free.task))?.status === "in-progress", "notagent: opening it puts the task back to in-progress");
	check((await call("POST", `/repos/${R}/forks/${tk.fork}/open`)).status === 409, "notagent: open again → 409");

	// order: creation order
	const ids = (await state(R)).tasks.map((t) => t.id);
	check(ids.join() === [sk.task, n1.task, n2.task, h.task, free.task].join(), "list keeps creation order");

	// push to n1 → it is pushed; placement needs containers, so it stops at "placing" here
	const d = join(mkdtempSync(join(tmpdir(), "smoke-")), "c");
	execSync(n1.clone.slice(0, -n1.fork.length) + d, { stdio: "ignore" });
	writeFileSync(join(d, "hello.txt"), "hi\n");
	execSync(`git add -A && git -c user.name=t -c user.email=t@t commit -qm "Add hello.txt" && ${n1.push}`, { cwd: d, stdio: "ignore" });
	let placing = false;
	for (let i = 0; i < 10 && !placing; i++) {
		await new Promise((r) => setTimeout(r, 2000));
		placing = (await state(R)).placing.includes(n1.fork);
	}
	check(placing, "push detected (placing; placement itself needs containers)");
	check((await call("POST", `/repos/${R}/forks/${n1.fork}/close`)).status === 409, "notagent: close a pushed fork → 409");
} finally {
	console.log("cleanup:", (await call("DELETE", `/repos/${R}`)).deleted?.length, "repos deleted");
	console.log(fails.length ? `FAILURES (${fails.length}):\n- ${fails.join("\n- ")}` : "ALL PASSED");
	process.exitCode = fails.length ? 1 : 0;
}
