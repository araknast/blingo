import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { APPLY_SH, CONFLICT, ENSURE_REP, FERGE_SH, MEMORY_HOOK_SH, MERGES, MERGE_SH, NO_CONFLICT, PATCH_SH, PUSH_SH, REP, readSeries } from "./git-scripts";
import { MODEL_HOSTS, egress, type Provider } from "./settings";
import type { Skill } from "./skills";
import { retryNote, validatePlan } from "./tasks";
import { NO_USAGE, completeLines, usageFromBody, type Usage } from "./transcript";

// Containers re-sign intercepted HTTPS with this CA; git/node/curl must trust it.
const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const TRUST = { NODE_EXTRA_CA_CERTS: CA, GIT_SSL_CAINFO: CA, CURL_CA_BUNDLE: CA, SSL_CERT_FILE: CA };
const GIT_ID = {
	GIT_AUTHOR_NAME: "blingo",
	GIT_AUTHOR_EMAIL: "blingo@blingo",
	GIT_COMMITTER_NAME: "blingo",
	GIT_COMMITTER_EMAIL: "blingo@blingo",
};
const TASK = "/workspace/task";
const CHECK_MS = 30_000;
const CI_CHECK_MS = 10_000;

// $1 remote, $2 prompt, $3 system prompt (memory items + how to leave notes), $4 Claude Code settings
// (the memory hook). Runs Claude Code on a clone, its whole run as stream-json in $TASK/transcript.jsonl,
// then commits. The Box pushes it to its own fork afterwards with a fresh token (a run can outlive the
// clone's). The commit it started from goes in $TASK/base (empty for an
// empty repo), for its patch series. Notes for future agents land in $TASK/memory, outside the repo.
const AGENT_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
git rev-parse -q --verify HEAD >${TASK}/base || true
claude --print --dangerously-skip-permissions --no-session-persistence --output-format stream-json --verbose --settings "$4" --model "$MODEL" --append-system-prompt "$3" -- "$2" >${TASK}/transcript.jsonl
git add -A
git commit -qm "$2" || true`;

// Superagent: same args, but a read-only clone and nothing is pushed; its plan is $TASK/tasks.json.
const SUPER_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
claude --print --dangerously-skip-permissions --no-session-persistence --output-format stream-json --verbose --settings "$4" --model "$MODEL" --append-system-prompt "$3" -- "$2" >${TASK}/transcript.jsonl`;

// CI: $1 fork remote (read), $2 the commit to check, $3 the repository's CI command. Exit = its exit.
const CI_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
git checkout -q --detach "$2"
set +e; bash -c "$3"`;

// Unpacks the JSON list of skills on stdin (name, files {path, data base64}) into Claude Code's user skills folder.
const UNPACK_SKILLS = `node -e '
const fs = require("fs"), path = require("path"), dir = path.join(require("os").homedir(), ".claude", "skills");
for (const s of JSON.parse(fs.readFileSync(0, "utf8")))
	for (const f of s.files) {
		const p = path.join(dir, s.name, f.path);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, Buffer.from(f.data, "base64"));
	}'`;

const NOTES = `To leave a note for every future agent on this repository, append it as one line to ${TASK}/memory.
Only note durable, repository-wide facts (conventions, gotchas, decisions), not progress on your own task.

You have internet access and run as root in a disposable Debian container: install whatever tools you need (apt-get, npm, pip, curl ...).`;

// ponytail: every memory item goes into every prompt; select or summarize them if the list grows long.
function systemPrompt(kind: AgentJob["kind"], memory: string[], skills: Skill[]) {
	const role =
		kind === "superagent"
			? `You plan work on this repository; you do not change it. Split the request into tasks and write them to ${TASK}/tasks.json as a JSON array of
{"key": short unique id, "title": a short summary of at most 60 characters, "description": everything an agent needs to do the task without other context, "kind": "agent" or "notagent", "deps": [keys of tasks that must land first], "skills": [names of the repository skills the task's agent should have; leave the field out to give it all of them, [] for none]}.
Each task is done on its own fork, in parallel with tasks it doesn't depend on, so keep tasks small and their files separate where you can.
Use "notagent" only for tasks that need a human (credentials, decisions, manual testing); prefer "agent".`
			: `You are doing one task on a fork of a shared repository; other agents do other tasks in parallel.
Commit your work with messages that explain what you did and why: they become the task's record.`;
	const mem = memory.length ? `\n\nNotes from earlier agents on this repository:\n${memory.map((m) => `- ${m}`).join("\n")}` : "";
	const list = skills.map((s) => `- "${s.name}" — ${s.description}`).join("\n");
	const sk = !skills.length
		? ""
		: kind === "superagent"
			? `\n\nThis repository's skills (assign them to tasks by name in "skills"):\n${list}`
			: `\n\nSkills installed for this task (Claude Code loads them when relevant):\n${list}`;
	return `${role}\n\n${NOTES}${mem}${sk}`;
}

// Claude Code settings for agents: the memory hook (MEMORY_HOOK_SH, written to $TASK at start).
const AGENT_SETTINGS = JSON.stringify({ hooks: { PostToolBatch: [{ hooks: [{ type: "command", command: `bash ${TASK}/memory-hook.sh ${TASK}` }] }] } });
// A transcript line bigger than this is stored as a stub (SQLite rows max out at 2 MB).
const MAX_LINE = 256_000;

// Detach from the exec so the task outlives the request; exit code lands atomically in $TASK/exit.
const BG_SH = `setsid bash -c "$0" agent "$@" >${TASK}/log 2>&1; echo $? >${TASK}/exit.tmp && mv ${TASK}/exit.tmp ${TASK}/exit`;

export type Run = { exitCode: number; stdout: string; stderr: string };
// kind "superagent": `fork` is only the run's id (no fork exists) and `remote` is read-only.
// `run`: the run's id when it isn't the fork's (a CI fixer: <fork>-c<n>); the Box is named after it.
// `model`/`provider`: the repository's choice (RepoDO.agentConfig); the API key is added by Outbound.
export type AgentJob = {
	repo: string;
	fork: string;
	run?: string;
	remote: string;
	prompt: string;
	kind?: "agent" | "superagent";
	memory?: string[];
	skills?: Skill[]; // an agent installs them; a superagent is only told of them
	model?: string;
	provider?: Provider;
	previous?: string; // a retry: the run id of the failed attempt, whose transcript and log it gets
};
// A CI run on a loose fork at `head`, in a Box named ci-<fork> that can reach only Artifacts and `hosts`.
// A deployment is the same job: `fork` is then the bubble, `head` its commit, and `deploy` the deployment run.
export type CiJob = { repo: string; fork: string; head: string; remote: string; command: string; hosts: string[]; deploy?: { id: string; name: string } };

export async function headOf(env: Env, name: string) {
	using repo = await env.ARTIFACTS.get(name);
	return (await repo.log({ limit: 1 }))[0]?.hash ?? "";
}

export async function forkRepo(env: Env, from: string, repo: string) {
	const name = `${repo}-f-${crypto.randomUUID().slice(0, 8)}`;
	using src = await env.ARTIFACTS.get(from);
	await src.fork(name, { defaultBranchOnly: true });
	return name;
}

// Embeds a short-lived repo token in the remote URL (scoped to that one repo).
export async function authRemote(env: Env, name: string, scope: "read" | "write", ttl = 900) {
	using repo = await env.ARTIFACTS.get(name);
	const { remote } = await repo.info();
	const token = await repo.createToken(scope, ttl);
	return {
		url: `https://x:${token.plaintext.split("?expires=")[0]}@${remote.slice("https://".length)}`,
		remote,
		token,
	};
}

// Every request out of a sandbox comes through here (rules: settings.ts `egress`). Agent Boxes
// (props.repo) reach the internet, and their repository's model API with its own key added here, so
// no key ever enters a sandbox; there is no fallback key. CI Boxes (props.ci = its hosts) reach only
// Artifacts and those hosts, other Boxes only Artifacts.
// `box`: the agent Box's name, which is told each model response's token use (Box.addUsage).
export class Outbound extends WorkerEntrypoint<Env, { ci?: string[]; repo?: string; box?: string; deploy?: { repo: string; name: string } }> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { ci, repo, box, deploy } = this.ctx.props ?? {};
		const creds = repo && Object.values(MODEL_HOSTS).includes(url.hostname) ? await this.env.REPO.getByName(repo).credentials() : null;
		const to = egress(url, { ci, agent: !!repo, provider: creds?.provider });
		if (to === "pass") {
			// A deployment's credentials are added here, to the hosts they are for.
			const extra = deploy ? await this.env.REPO.getByName(deploy.repo).deployHeaders(deploy.name, url.hostname) : [];
			if (!extra.length) return fetch(request);
			const headers = new Headers(request.headers);
			for (const [k, v] of extra) headers.set(k, v);
			return fetch(new Request(request, { headers }));
		}
		if (to !== "key") return new Response(`${to.deny}\n`, { status: 403 });
		const headers = new Headers(request.headers);
		headers.delete("x-api-key");
		headers.delete("authorization");
		headers.set("authorization", `Bearer ${creds!.key}`);
		if (creds!.provider === "claude-subscription") {
			// A subscription token is only accepted with the OAuth beta flag.
			const betas = (headers.get("anthropic-beta") ?? "").split(",").map((b) => b.trim()).filter(Boolean);
			if (!betas.includes("oauth-2025-04-20")) betas.push("oauth-2025-04-20");
			headers.set("anthropic-beta", betas.join(","));
		}
		const res = await fetch(new Request(request, { headers }));
		if (!box || !res.body) return res;
		// Read a copy of the body for its token use; the agent gets the other copy as it streams.
		const [mine, theirs] = res.body.tee();
		this.ctx.waitUntil(
			new Response(mine)
				.text()
				.then((t) => {
					const u = usageFromBody(t);
					if (u.input || u.output || u.cacheRead || u.cacheWrite) return this.env.BOX.getByName(box).addUsage(u);
				})
				.catch(() => {}),
		);
		return new Response(theirs, res);
	}
}

// One Linux sandbox. Each agent gets its own; each bubble gets one holding its rep (see REP); RepoDO
// uses one per repo to turn notagent forks into patch series.
export class Box extends DurableObject<Env> {
	private setup?: Promise<void>;
	private sql = this.ctx.storage.sql;
	private queue: Promise<unknown> = Promise.resolve(); // rep jobs, one at a time

	private get container() {
		if (!this.ctx.container) throw new Error("container binding not configured");
		return this.ctx.container;
	}

	private async start() {
		if (this.setup === undefined || !this.container.running) {
			this.setup = (async () => {
				const c = this.container;
				if (!c.running) c.start({ image: c.images.box, instance: "standard-1", enableInternet: false });
				const ci = this.ctx.storage.kv.get<CiJob>("ci");
				const repo = this.ctx.storage.kv.get<string>("egress"); // an agent's repository
				const outbound = ci
					? this.ctx.exports.Outbound({ props: { ci: ci.hosts, deploy: ci.deploy && { repo: ci.repo, name: ci.deploy.name } } })
					: repo
						? this.ctx.exports.Outbound({ props: { repo, box: this.ctx.id.name } })
						: this.ctx.exports.Outbound;
				try {
					await c.interceptAllOutboundHttp(outbound);
					await c.interceptOutboundHttps("*", outbound);
					await c.setInactivityTimeout(30 * 60_000);
				} catch (e) {
					await c.destroy();
					throw e;
				}
			})().catch((e) => {
				this.setup = undefined;
				throw e;
			});
		}
		await this.setup;
	}

	async sh(script: string, args: string[] = [], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
		await this.start();
		const p = await this.container.exec(["bash", "-c", script, "sh", ...args], {
			cwd: "/workspace",
			env: { ...TRUST, ...GIT_ID, ...opts.env },
			stdin: opts.stdin === undefined ? undefined : new Response(opts.stdin).body!,
		});
		const out = await p.output();
		const dec = new TextDecoder();
		return { exitCode: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
	}

	// ---- a bubble's rep (this Box is its only writer) ----

	// Runs `jobs` in order on the rep clone, after any earlier rep job here finishes. A job failing with
	// anything but a conflict drops the clone, so the next job starts again from what was pushed.
	private rep<T>(remote: string, jobs: (run: (script: string, args?: string[], opts?: { stdin?: string; env?: Record<string, string> }) => Promise<Run>) => Promise<T>) {
		const go = async () => {
			const run = async (script: string, args: string[] = [], opts = {}) => {
				const r = await this.sh(ENSURE_REP + script, [remote, ...args], opts);
				if (r.exitCode !== 0 && r.exitCode !== CONFLICT && r.exitCode !== NO_CONFLICT) {
					await this.sh(`rm -rf ${REP}`);
					throw new Error(`rep job failed (${r.exitCode}): ${r.stderr}`);
				}
				return r;
			};
			return jobs(run);
		};
		const p = this.queue.then(go, go);
		this.queue = p.catch(() => {});
		return p;
	}

	// Applies each fork's patch series in order and pushes once. A series that doesn't apply is left
	// out whole; the rest still land.
	async apply(remote: string, series: { fork: string; mbox: string; committer: { name: string; email: string } }[]): Promise<boolean[]> {
		return this.rep(remote, async (run) => {
			const ok: boolean[] = [];
			for (const s of series) {
				const r = await run(APPLY_SH, [], { stdin: s.mbox, env: { GIT_COMMITTER_NAME: s.committer.name, GIT_COMMITTER_EMAIL: s.committer.email } });
				ok.push(r.exitCode === 0);
			}
			if (ok.some(Boolean)) await run(PUSH_SH);
			return ok;
		});
	}

	// Merges another repo (a neighbour bubble's rep, or a fork from before patch series) into the rep.
	async mergeFrom(remote: string, src: string, message: string): Promise<{ ok: boolean; diff: string }> {
		return this.rep(remote, async (run) => {
			const r = await run(MERGE_SH, [src, message]);
			return { ok: r.exitCode === 0, diff: r.exitCode === 0 ? r.stdout : "" };
		});
	}

	// Ferge with bubble `b` (see FERGE_SH); `locked` is the new locked bubble's repo, a fork of this rep.
	async ferge(remote: string, b: string, locked: string): Promise<{ files: string[]; tree: string[] } | null> {
		return this.rep(remote, async (run) => {
			const r = await run(FERGE_SH, [b, locked]);
			if (r.exitCode === NO_CONFLICT) return null;
			const [files, tree] = r.stdout.split(/^==$/m).map((s) => s.split("\n").filter(Boolean));
			return { files, tree };
		});
	}

	// The bubble is gone (absorbed): drop its container.
	async stop() {
		if (this.ctx.container?.running) await this.container.destroy().catch(() => {});
	}

	async startAgent(job: AgentJob): Promise<void> {
		if (this.ctx.storage.kv.get<string>("egress") !== job.repo && this.ctx.container?.running) {
			await this.container.destroy().catch(() => {}); // Outbound is bound to its repository at start
			this.setup = undefined;
		}
		this.ctx.storage.kv.put("egress", job.repo);
		await this.start();
		await this.sh(`rm -rf ${TASK} && mkdir -p ${TASK}`);
		await this.sh(`cat > ${TASK}/memory-hook.sh`, [], { stdin: MEMORY_HOOK_SH });
		// Only the chosen skills: nothing else is in the user skills folder.
		await this.sh(`rm -rf ~/.claude/skills`);
		if (job.kind !== "superagent" && job.skills?.length) await this.sh(UNPACK_SKILLS, [], { stdin: JSON.stringify(job.skills) });
		let prompt = job.prompt;
		if (job.previous) {
			const prev = this.env.BOX.getByName(job.previous);
			const [text, s] = await Promise.all([prev.transcriptText(), prev.status()]);
			if (text) {
				const file = `${TASK}/previous.jsonl`;
				await this.sh(`cat > ${file}`, [], { stdin: text });
				prompt += `\n\n${retryNote({ file, ...s })}`;
			}
		}
		this.transcriptTable();
		this.sql.exec("DELETE FROM transcript");
		const script = job.kind === "superagent" ? SUPER_SH : AGENT_SH;
		// Placeholders: Outbound sets the real key. OpenRouter speaks the Anthropic API at its own base URL.
		const auth: Record<string, string> =
			job.provider === "openrouter"
				? { ANTHROPIC_BASE_URL: "https://openrouter.ai/api", ANTHROPIC_AUTH_TOKEN: "added-by-outbound", ANTHROPIC_API_KEY: "" }
				: { CLAUDE_CODE_OAUTH_TOKEN: "added-by-outbound", ANTHROPIC_API_KEY: "" };
		await this.container.exec(["bash", "-c", BG_SH, script, job.remote, prompt, systemPrompt(job.kind, job.memory ?? [], job.skills ?? []), AGENT_SETTINGS], {
			cwd: "/workspace",
			env: {
				...TRUST,
				...GIT_ID,
				MODEL: job.model ?? this.env.MODEL,
				...auth,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				IS_SANDBOX: "1",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		this.ctx.storage.kv.put("job", { ...job, remote: "", memory: [], skills: [] }); // don't persist the token
		this.ctx.storage.kv.put("status", "running");
		this.ctx.storage.kv.delete("reason");
		this.ctx.storage.kv.delete("usage");
		await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
	}

	// Starts CI on a loose fork, replacing any CI still running here (a newer push supersedes it).
	async startCI(job: CiJob): Promise<void> {
		if (this.ctx.container?.running) await this.container.destroy().catch(() => {});
		this.setup = undefined;
		this.ctx.storage.kv.put("ci", { ...job, remote: "" }); // read by start(); don't persist the token
		await this.start();
		await this.sh(`rm -rf ${TASK} && mkdir -p ${TASK}`);
		await this.container.exec(["bash", "-c", BG_SH, CI_SH, job.remote, job.head, job.command], {
			cwd: "/workspace",
			env: { ...TRUST, ...GIT_ID },
			stdout: "ignore",
			stderr: "ignore",
		});
		this.ctx.storage.kv.put("status", "running");
		await this.ctx.storage.setAlarm(Date.now() + CI_CHECK_MS);
	}

	// New memory items for the running agent: its memory hook passes them to the model (MEMORY_HOOK_SH).
	async pushMemory(memory: string[]) {
		if (!this.ctx.storage.kv.get("job") || !this.ctx.container?.running) return;
		await this.sh(`cat > ${TASK}/memory.md.tmp && mv ${TASK}/memory.md.tmp ${TASK}/memory.md`, [], { stdin: memory.map((m) => `- ${m}`).join("\n") + "\n" });
	}

	private transcriptTable() {
		this.sql.exec("CREATE TABLE IF NOT EXISTS transcript(seq INTEGER PRIMARY KEY, line TEXT NOT NULL)");
	}

	// The agent's Claude Code run as stream-json events (see the Agents page): live from the container
	// while it runs, else as stored when it finished.
	// `from` is a line cursor: only events after the first `from` lines are returned, with the cursor to
	// pass next time. (Stored transcripts drop blank lines, so the client refetches from 0 once a run ends.)
	// `reason`: why a run whose agent finished failed anyway (its change wasn't submitted).
	// `usage`: its token use so far (absent for runs from before it was counted).
	async transcript(from = 0): Promise<{ status: string; reason?: string; usage?: Usage; events: unknown[]; next: number }> {
		this.transcriptTable();
		from = Math.max(0, Math.floor(from) || 0);
		const status = this.ctx.storage.kv.get<string>("status") ?? "none";
		const usage = this.ctx.storage.kv.get<Usage>("usage");
		if (this.ctx.storage.kv.get("job") && this.ctx.container?.running) {
			const raw = (await this.sh(`tail -n +${from + 1} ${TASK}/transcript.jsonl 2>/dev/null | head -c 8000000 || true`)).stdout;
			const { lines, count } = completeLines(raw);
			return { status, usage, events: lines.map(parseEvent), next: from + count };
		}
		const rows = this.sql.exec<{ line: string }>("SELECT line FROM transcript WHERE seq >= ? ORDER BY seq", from).toArray();
		return { status, reason: this.ctx.storage.kv.get<string>("reason"), usage, events: rows.map((r) => parseEvent(r.line)), next: from + rows.length };
	}

	// Stores the finished run's transcript; returns its final result text (or error) for the run's log.
	private async saveTranscript(): Promise<string> {
		this.transcriptTable();
		const lines = (await this.sh(`cat ${TASK}/transcript.jsonl 2>/dev/null || true`)).stdout.split("\n").filter(Boolean);
		this.sql.exec("DELETE FROM transcript");
		lines.forEach((l, i) => this.sql.exec("INSERT INTO transcript (seq, line) VALUES (?, ?)", i, l.length > MAX_LINE ? JSON.stringify({ type: "truncated", bytes: l.length }) : l));
		const last = parseEvent(lines.at(-1) ?? "") as { type?: string; result?: string };
		return last.type === "result" && typeof last.result === "string" ? last.result : "";
	}

	status() {
		const kv = this.ctx.storage.kv;
		return { status: kv.get<string>("status") ?? "none", log: kv.get<string>("log"), reason: kv.get<string>("reason") };
	}

	// The run's token use so far, summed over its model responses (Outbound reports each).
	addUsage(u: Usage) {
		const t = this.ctx.storage.kv.get<Usage>("usage") ?? NO_USAGE;
		this.ctx.storage.kv.put("usage", { input: t.input + u.input, output: t.output + u.output, cacheRead: t.cacheRead + u.cacheRead, cacheWrite: t.cacheWrite + u.cacheWrite });
	}

	// The finished run's stored transcript as JSONL (for a retry of it).
	transcriptText(): string {
		this.transcriptTable();
		return this.sql.exec<{ line: string }>("SELECT line FROM transcript ORDER BY seq").toArray().map((r) => r.line).join("\n");
	}

	// Stops the running agent on request; its transcript so far is kept. Returns whether one was running.
	async stopAgent(): Promise<boolean> {
		const job = this.ctx.storage.kv.get<AgentJob>("job");
		if (!job) return false;
		if (this.container.running) await this.saveTranscript().catch(() => "");
		const reason = "stopped by a person";
		await this.finish(job, "failed", reason, reason);
		return true;
	}

	async alarm(): Promise<void> {
		const ci = this.ctx.storage.kv.get<CiJob>("ci");
		if (ci) return this.ciAlarm(ci);
		const job = this.ctx.storage.kv.get<AgentJob>("job");
		if (!job) return;
		if (!this.container.running) return this.finish(job, "lost", "container stopped before the agent finished");
		const exit = await this.sh(`cat ${TASK}/exit 2>/dev/null || true`);
		if (exit.stdout.trim() === "") {
			await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
			return;
		}
		const result = await this.saveTranscript();
		const log = [(await this.sh(`tail -c 4000 ${TASK}/log`)).stdout.trim(), result.slice(-4000)].filter(Boolean).join("\n\n");
		if (exit.stdout.trim() !== "0") return this.finish(job, "failed", log);
		// Claude finished but its change didn't make it in: the reason is shown with the run.
		const unsubmitted = (reason: string) => this.finish(job, "failed", `${log}\n${reason}`, reason);
		const repo = this.env.REPO.getByName(job.repo);
		let loose = false;
		if (job.kind === "superagent") {
			const raw = (await this.sh(`cat ${TASK}/tasks.json 2>/dev/null || true`)).stdout;
			let plan: ReturnType<typeof validatePlan>;
			try {
				plan = validatePlan(JSON.parse(raw), await repo.skillNames());
			} catch {
				plan = { error: raw.trim() ? "tasks.json is not JSON" : `it wrote no plan to ${TASK}/tasks.json` };
			}
			if ("error" in plan) return unsubmitted(`plan rejected: ${plan.error}`);
			await repo.addTasks(job.repo, plan.items, job.fork);
		} else {
			const { url } = await authRemote(this.env, job.fork, "write");
			const push = await this.sh(`cd /workspace/repo && git push -q "$1" HEAD:refs/heads/main`, [url]);
			if (push.exitCode !== 0) return unsubmitted(`couldn't push its commit: ${push.stderr.trim().split("\n").at(-1) || `exit ${push.exitCode}`}`);
			const base = (await this.sh(`cat ${TASK}/base 2>/dev/null || true`)).stdout.trim();
			const p = await this.sh(PATCH_SH, ["/workspace/repo", base]);
			if (p.exitCode === MERGES) return unsubmitted("not placed: its history has merge commits");
			if (p.exitCode !== 0) throw new Error(`patch series of ${job.fork} (${p.exitCode}): ${p.stderr}`);
			const { files, mbox } = readSeries(p.stdout);
			const placed = await repo.submit(job.fork, files, mbox);
			if ("error" in placed) return unsubmitted(`not placed: ${placed.error}`);
			loose = "loose" in placed;
		}
		// Notes the agent left for future agents (capped: they all go into every prompt).
		const notes = (await this.sh(`head -c 20000 ${TASK}/memory 2>/dev/null || true`)).stdout;
		const items = notes.split("\n").map((l) => l.trim().slice(0, 500)).filter(Boolean).slice(0, 10);
		if (items.length) await repo.addMemory(items, job.fork);
		await this.finish(job, job.kind === "superagent" ? "planned" : loose ? "loose" : "placed", log);
	}

	private async ciDone(job: CiJob, ok: boolean, log: string) {
		this.ctx.storage.kv.delete("ci");
		this.ctx.storage.kv.put("status", ok ? "passed" : "failed");
		this.ctx.storage.kv.put("log", log);
		await this.container.destroy().catch(() => {});
		const repo = this.env.REPO.getByName(job.repo);
		if (job.deploy) await repo.deployDone(job.deploy.id, ok, log);
		else await repo.ciDone(job.fork, job.head, ok, log);
	}

	// A person cancels the CI job or deployment running here: it fails with its output so far. What its
	// command already did (a half-finished deploy, say) isn't undone.
	async stopCI(): Promise<boolean> {
		const job = this.ctx.storage.kv.get<CiJob>("ci");
		if (!job) return false;
		const tail = this.container.running ? (await this.sh(`tail -c 7900 ${TASK}/log 2>/dev/null || true`).catch(() => ({ stdout: "" }))).stdout : "";
		await this.ciDone(job, false, `${tail.trimEnd()}\ncancelled by a person`.trim());
		return true;
	}

	private async ciAlarm(job: CiJob) {
		const done = (ok: boolean, log: string) => this.ciDone(job, ok, log);
		if (!this.container.running) return done(false, "the CI container stopped before CI finished");
		const exit = (await this.sh(`cat ${TASK}/exit 2>/dev/null || true`)).stdout.trim();
		if (exit === "") return void (await this.ctx.storage.setAlarm(Date.now() + CI_CHECK_MS));
		await done(exit === "0", (await this.sh(`tail -c 8000 ${TASK}/log`)).stdout);
	}

	// "loose": the fork waits for CI. A failed first run deletes its fork; a failed fixer leaves it.
	private async finish(job: AgentJob, status: string, log: string, reason?: string) {
		if ((status === "failed" || status === "lost") && job.kind !== "superagent" && !job.run) await this.env.ARTIFACTS.delete(job.fork);
		this.ctx.storage.kv.delete("job");
		await this.env.REPO.getByName(job.repo).agentDone(job.run ?? job.fork, status, log);
		this.ctx.storage.kv.put("status", status);
		this.ctx.storage.kv.put("log", log);
		if (reason) this.ctx.storage.kv.put("reason", reason);
		await this.container.destroy().catch(() => {});
	}
}

function parseEvent(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return { type: "raw", text: line };
	}
}
