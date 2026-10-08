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

	// notagents: description required; title given or defaulted
	check((await call("POST", "/notagents", { repo: R })).status === 400, "notagent: description required");
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

	// order: creation order
	const ids = (await state(R)).tasks.map((t) => t.id);
	check(ids.join() === [n1.task, n2.task, h.task, free.task].join(), "list keeps creation order");

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
} finally {
	console.log("cleanup:", (await call("DELETE", `/repos/${R}`)).deleted?.length, "repos deleted");
	console.log(fails.length ? `FAILURES (${fails.length}):\n- ${fails.join("\n- ")}` : "ALL PASSED");
	process.exitCode = fails.length ? 1 : 0;
}
