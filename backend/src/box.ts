import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { APPLY_SH, CONFLICT, ENSURE_REP, FERGE_SH, MERGES, MERGE_SH, NO_CONFLICT, PATCH_SH, PUSH_SH, REP, readSeries } from "./git-scripts";
import { validatePlan } from "./tasks";

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

// $1 remote, $2 prompt, $3 system prompt (memory items + how to leave notes). Runs Claude Code on a
// clone, commits, pushes to its own fork. The commit it started from goes in $TASK/base (empty for an
// empty repo), for its patch series. Notes for future agents land in $TASK/memory, outside the repo.
const AGENT_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
git rev-parse -q --verify HEAD >${TASK}/base || true
claude --print --dangerously-skip-permissions --no-session-persistence --model "$MODEL" --append-system-prompt "$3" -- "$2"
git add -A
git commit -qm "$2" || true
git push -q origin HEAD:refs/heads/main`;

// Superagent: same args, but a read-only clone and nothing is pushed; its plan is $TASK/tasks.json.
const SUPER_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
claude --print --dangerously-skip-permissions --no-session-persistence --model "$MODEL" --append-system-prompt "$3" -- "$2"
test -s ${TASK}/tasks.json`;

const NOTES = `To leave a note for every future agent on this repository, append it as one line to ${TASK}/memory.
Only note durable, repository-wide facts (conventions, gotchas, decisions), not progress on your own task.`;

// ponytail: every memory item goes into every prompt; select or summarize them if the list grows long.
function systemPrompt(kind: AgentJob["kind"], memory: string[]) {
	const role =
		kind === "superagent"
			? `You plan work on this repository; you do not change it. Split the request into tasks and write them to ${TASK}/tasks.json as a JSON array of
{"key": short unique id, "title": a short summary of at most 60 characters, "description": everything an agent needs to do the task without other context, "kind": "agent" or "notagent", "deps": [keys of tasks that must land first]}.
Each task is done on its own fork, in parallel with tasks it doesn't depend on, so keep tasks small and their files separate where you can.
Use "notagent" only for tasks that need a human (credentials, decisions, manual testing); prefer "agent".`
			: `You are doing one task on a fork of a shared repository; other agents do other tasks in parallel.
Commit your work with messages that explain what you did and why: they become the task's record.`;
	const mem = memory.length ? `\n\nNotes from earlier agents on this repository:\n${memory.map((m) => `- ${m}`).join("\n")}` : "";
	return `${role}\n\n${NOTES}${mem}`;
}

// Detach from the exec so the task outlives the request; exit code lands atomically in $TASK/exit.
const BG_SH = `setsid bash -c "$0" agent "$@" >${TASK}/log 2>&1; echo $? >${TASK}/exit.tmp && mv ${TASK}/exit.tmp ${TASK}/exit`;

export type Run = { exitCode: number; stdout: string; stderr: string };
// kind "superagent": `fork` is only the run's id (no fork exists) and `remote` is read-only.
export type AgentJob = { repo: string; fork: string; remote: string; prompt: string; kind?: "agent" | "superagent"; memory?: string[] };

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

// The only egress the sandbox gets: Artifacts git, and Anthropic with the key added here.
export class Outbound extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.protocol !== "https:") return new Response("https only\n", { status: 403 });
		if (url.hostname.endsWith(".artifacts.cloudflare.net")) return fetch(request);
		if (url.hostname === "api.anthropic.com") {
			const headers = new Headers(request.headers);
			headers.set("x-api-key", this.env.ANTHROPIC_API_KEY);
			return fetch(new Request(request, { headers }));
		}
		return new Response(`${url.hostname} not reachable\n`, { status: 403 });
	}
}

// One Linux sandbox. Each agent gets its own; each bubble gets one holding its rep (see REP); RepoDO
// uses one per repo to turn notagent forks into patch series.
export class Box extends DurableObject<Env> {
	private setup?: Promise<void>;
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
				try {
					await c.interceptAllOutboundHttp(this.ctx.exports.Outbound);
					await c.interceptOutboundHttps("*", this.ctx.exports.Outbound);
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
		await this.start();
		await this.sh(`rm -rf ${TASK} && mkdir -p ${TASK}`);
		const script = job.kind === "superagent" ? SUPER_SH : AGENT_SH;
		await this.container.exec(["bash", "-c", BG_SH, script, job.remote, job.prompt, systemPrompt(job.kind, job.memory ?? [])], {
			cwd: "/workspace",
			env: {
				...TRUST,
				...GIT_ID,
				MODEL: this.env.MODEL,
				ANTHROPIC_API_KEY: "added-by-outbound", // placeholder; Outbound sets the real key
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				IS_SANDBOX: "1",
			},
			stdout: "ignore",
			stderr: "ignore",
		});
		this.ctx.storage.kv.put("job", { ...job, remote: "", memory: [] }); // don't persist the token
		this.ctx.storage.kv.put("status", "running");
		await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
	}

	status() {
		return { status: this.ctx.storage.kv.get<string>("status") ?? "none", log: this.ctx.storage.kv.get<string>("log") };
	}

	async alarm(): Promise<void> {
		const job = this.ctx.storage.kv.get<AgentJob>("job");
		if (!job) return;
		if (!this.container.running) return this.finish(job, "lost", "container stopped before the agent finished");
		const exit = await this.sh(`cat ${TASK}/exit 2>/dev/null || true`);
		if (exit.stdout.trim() === "") {
			await this.ctx.storage.setAlarm(Date.now() + CHECK_MS);
			return;
		}
		const log = (await this.sh(`tail -c 4000 ${TASK}/log`)).stdout;
		if (exit.stdout.trim() !== "0") return this.finish(job, "failed", log);
		const repo = this.env.REPO.getByName(job.repo);
		if (job.kind === "superagent") {
			let plan: ReturnType<typeof validatePlan>;
			try {
				plan = validatePlan(JSON.parse((await this.sh(`cat ${TASK}/tasks.json`)).stdout));
			} catch {
				plan = { error: "tasks.json is not JSON" };
			}
			if ("error" in plan) return this.finish(job, "failed", `${log}\nplan rejected: ${plan.error}`);
			await repo.addTasks(job.repo, plan.items, job.fork);
		} else {
			const base = (await this.sh(`cat ${TASK}/base 2>/dev/null || true`)).stdout.trim();
			const p = await this.sh(PATCH_SH, ["/workspace/repo", base]);
			if (p.exitCode === MERGES) return this.finish(job, "failed", `${log}\nnot placed: its history has merge commits`);
			if (p.exitCode !== 0) throw new Error(`patch series of ${job.fork} (${p.exitCode}): ${p.stderr}`);
			const { files, mbox } = readSeries(p.stdout);
			const placed = await repo.place(job.fork, files, mbox);
			if ("error" in placed) return this.finish(job, "failed", `${log}\nnot placed: ${placed.error}`);
		}
		// Notes the agent left for future agents (capped: they all go into every prompt).
		const notes = (await this.sh(`head -c 20000 ${TASK}/memory 2>/dev/null || true`)).stdout;
		const items = notes.split("\n").map((l) => l.trim().slice(0, 500)).filter(Boolean).slice(0, 10);
		if (items.length) await repo.addMemory(items, job.fork);
		await this.finish(job, job.kind === "superagent" ? "planned" : "placed", log);
	}

	private async finish(job: AgentJob, status: string, log: string) {
		if (status !== "placed" && job.kind !== "superagent") await this.env.ARTIFACTS.delete(job.fork);
		this.ctx.storage.kv.delete("job");
		await this.env.REPO.getByName(job.repo).agentDone(job.fork, status, log);
		this.ctx.storage.kv.put("status", status);
		this.ctx.storage.kv.put("log", log);
		await this.container.destroy().catch(() => {});
	}
}
