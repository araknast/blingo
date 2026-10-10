// Screenshots of a lived-in map against a deployed blingo: bubbles with names, a conflict, a ferge
// bubble, a loose fork that failed CI (and its page), a running agent and its run page.
// usage: YORKLE_URL=https://yorkle.<subdomain>.workers.dev BLINGO_TOKEN=… node e2e/ui-map.mjs [out dir]
// Pushes with git; deletes its repository at the end. The agent may fail fast without API credit.
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const U = process.env.YORKLE_URL;
const T = process.env.BLINGO_TOKEN;
if (!U || !T) throw new Error("set YORKLE_URL and BLINGO_TOKEN");
const out = process.argv[2] ?? join(root, "e2e/screens");
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "ui-map-"));

const api = async (method, path, body) => {
	const r = await fetch(`${U}/api${path}`, { method, headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
	const j = await r.json();
	if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
	return j;
};
const state = (R) => api("GET", `/repos/${R}`);
const until = async (R, cond, what) => {
	for (let i = 0; i < 60; i++) {
		if (cond(await state(R))) return;
		await new Promise((r) => setTimeout(r, 5000));
	}
	throw new Error(`timed out waiting for ${what}`);
};
const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@x", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@x" };
const push = (na, dir, edit) => {
	const url = na.push.replace(/^git push /, "").replace(/ HEAD:main$/, "");
	execSync(`git clone -q ${url} ${dir} && cd ${dir} && ${edit} && git add -A && git commit -qm ${JSON.stringify(dir)} && git push -q ${url} HEAD:main`, { cwd: work, env, shell: "/bin/bash" });
};

const { repo: R } = await api("POST", "/repos", { name: "Map tour" });
await api("PUT", `/repos/${R}/settings`, { apiKey: process.env.E2E_ANTHROPIC_KEY ?? "" }); // agents run only on their repository's key
console.log("repo", R);
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
try {
	const base = await api("POST", "/notagents", { repo: R, description: "base" });
	push(base, "base", `printf 'line1\\nline2\\n' > a.txt && echo b > b.txt`);
	await until(R, (d) => d.bubbles.length === 1, "the first bubble");
	const A = base.fork;
	const x1 = await api("POST", "/notagents", { repo: R, bubble: A, description: "ALPHA" });
	const x2 = await api("POST", "/notagents", { repo: R, bubble: A, description: "BETA" });
	const x3 = await api("POST", "/notagents", { repo: R, bubble: A, description: "docs" });
	push(x1, "x1", "sed -i s/line1/ALPHA/ a.txt");
	push(x2, "x2", "sed -i s/line1/BETA/ a.txt");
	push(x3, "x3", "echo docs > docs.md");
	await until(R, (d) => d.conflicts.length === 1, "a conflict");
	const B = (await state(R)).conflicts[0].find((x) => x !== A);
	await api("POST", `/repos/${R}/ferge`, { a: A, b: B });
	await api("PUT", `/repos/${R}/settings`, { ci: { enabled: true, command: "echo 'tests: 1 failing'; exit 1" } });
	const x4 = await api("POST", "/notagents", { repo: R, bubble: A, description: "Add a changelog" });
	push(x4, "x4", "echo changes > CHANGELOG.md");
	await until(R, (d) => d.loose.some((l) => l.fork === x4.fork && l.ci === "failed"), "CI to fail");
	await api("PUT", `/repos/${R}/settings`, { ci: { enabled: false } });
	const agent = await api("POST", "/agents", { repo: R, bubble: A, title: "Add a README", prompt: "Add a README.md describing this repository." });

	const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
	await ctx.addInitScript((t) => localStorage.setItem("blingo-token", t), T);
	const page = await ctx.newPage();
	const shot = async (name) => {
		await page.waitForTimeout(1500);
		await page.screenshot({ path: join(out, `${name}.png`) });
		console.log("wrote", name);
	};
	await page.goto(`${U}/repos/${R}`);
	await page.getByRole("link", { name: /ferge/ }).first().waitFor();
	await shot("map-1-tour");
	await page.goto(`${U}/repos/${R}/forks/${x4.fork}`);
	await page.getByText("tests: 1 failing").waitFor();
	await shot("map-2-loose-fork");
	await page.goto(`${U}/repos/${R}/agents/${agent.fork}`);
	await page.getByRole("heading", { name: /Add a README/ }).waitFor();
	await page.waitForTimeout(25000); // let the run start (or fail) so its transcript shows
	await shot("map-3-agent");
} finally {
	await browser.close();
	console.log("cleanup:", (await api("DELETE", `/repos/${R}`)).deleted.length, "repos deleted");
	execSync(`rm -rf ${work}`);
}
