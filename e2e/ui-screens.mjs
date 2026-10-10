// Screenshots of the splash page and a repository's Map, Tasks, Agents, Memory and Settings tabs,
// seeded with a mix of tasks.
// usage: npm run dev -- --enable-containers=false   (both Workers on :8787), then
//        node e2e/ui-screens.mjs [out dir]   # YORKLE_URL (default http://localhost:8787), BLINGO_TOKEN (default: backend/.dev.vars)
// Creates one repository and deletes it at the end.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url).pathname;
const U = process.env.YORKLE_URL ?? "http://localhost:8787";
const T = process.env.BLINGO_TOKEN ?? readFileSync(join(root, "backend/.dev.vars"), "utf8").match(/^BLINGO_TOKEN=["']?([^"'\n]+)/m)[1];
const out = process.argv[2] ?? join(root, "e2e/screens");
mkdirSync(out, { recursive: true });

const api = async (method, path, body) => {
	const r = await fetch(`${U}/api${path}`, { method, headers: { authorization: `Bearer ${T}`, "content-type": "application/json" }, body: body && JSON.stringify(body) });
	const j = await r.json();
	if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`);
	return j;
};

// CHROMIUM = a browser binary, when Playwright's own download doesn't match its version.
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const { repo: R } = await api("POST", "/repos", { name: "Screenshot repo" });
console.log("repo", R);
try {
	const n1 = await api("POST", "/notagents", { repo: R, title: "Add a greeting file", description: "Add hello.txt with a friendly greeting." });
	const docs = await api("POST", `/repos/${R}/tasks`, {
		title: "Write the API docs",
		description: "Document every route in `backend/src/index.ts`:\n\n- method and path\n- body and response\n- auth rules\n\nPut it in `docs/api.md`.",
		kind: "notagent",
	});
	const review = await api("POST", `/repos/${R}/tasks`, { title: "Review the greeting", description: "Check the wording of **hello.txt**.", kind: "notagent", deps: [n1.task] });
	await api("POST", `/repos/${R}/tasks`, { title: "Ship v1", description: "Tag and announce v1 once the docs and review are done.", kind: "agent", deps: [docs.task, review.task] });
	await api("POST", `/repos/${R}/memory`, { text: "Use tabs for indentation." });

	const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
	await ctx.addInitScript((t) => localStorage.setItem("blingo-token", t), T);
	const page = await ctx.newPage();
	const shot = async (name) => {
		await page.waitForTimeout(600);
		await page.screenshot({ path: join(out, `${name}.png`) });
		console.log("wrote", name);
	};

	const tab = (name) => page.getByRole("list", { name: "Repository" }).getByRole("link", { name });
	await page.goto(`${U}/repos/${R}`);
	await tab(/Tasks/).waitFor();
	await shot("1-map");

	await tab(/Tasks/).click();
	await page.getByText("Write the API docs").waitFor();
	await shot("2-tasks-open");

	await page.getByRole("link", { name: "Review the greeting" }).click();
	await page.getByRole("heading", { name: /Review the greeting/ }).waitFor();
	await shot("3-task-waiting");

	await page.goto(`${U}/repos/${R}/tasks/${docs.task}`);
	await page.getByRole("button", { name: "Take this task" }).waitFor();
	await shot("4-task-ready");
	await page.getByRole("button", { name: "Take this task" }).click();
	await page.getByText("Clone the fork").waitFor();
	await shot("5-take-dialog");

	await page.goto(`${U}/repos/${R}/tasks`);
	await page.getByRole("button", { name: "New task" }).click();
	await page.getByLabel("Title").waitFor();
	await shot("6-new-task");

	await page.goto(`${U}/repos/${R}/tasks?state=completed`);
	await page.getByText("Nothing completed yet").waitFor();
	await shot("7-completed-empty");

	await tab("Agents").click();
	await page.getByRole("heading", { name: "Agents" }).waitFor();
	await shot("9-agents");
	await tab("Memory").click();
	await page.getByText("Use tabs for indentation.").waitFor();
	await shot("10-memory");
	await tab("Settings").click();
	await page.getByRole("button", { name: "Save settings" }).waitFor();
	await shot("11-settings");

	const out_ = await browser.newContext({ viewport: { width: 1360, height: 860 } });
	const splash = await out_.newPage();
	await splash.goto(`${U}/`);
	await splash.getByRole("heading", { name: /Run many coding agents/ }).waitFor();
	await splash.waitForTimeout(2500);
	await splash.screenshot({ path: join(out, "12-splash.png") });
	console.log("wrote", "12-splash");
	await out_.close();

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`${U}/repos/${R}/tasks`);
	await page.getByText("Write the API docs").waitFor();
	await shot("8-tasks-mobile");
} finally {
	await browser.close();
	console.log("cleanup:", (await api("DELETE", `/repos/${R}`)).deleted.length, "repos deleted");
}
