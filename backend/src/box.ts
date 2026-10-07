import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

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
export const CONFLICT = 10;

// Files changed since $base (empty base = repo started empty → every file ever touched).
const FILES_SH = `if [ -n "$base" ]; then git diff --name-only "$base" HEAD; else git log --name-only --format=; fi | sed '/^$/d' | sort -u`;

// $1 remote, $2 base → changed files on stdout.
export const CHANGED_FILES_SH = `set -e; base=$2; d=$(mktemp -d); git clone -q "$1" "$d"; cd "$d"; ${FILES_SH}`;

// $1 rep remote (write), $2 source remote (read). Rebases source onto rep and fast-forwards rep.
// Exit 0 + diff of source on stdout; exit ${CONFLICT} = rebase conflict; anything else = infra error.
export const REBASE_SH = `set -e
d=$(mktemp -d); git clone -q "$1" "$d"; cd "$d"
rep=$(git rev-parse HEAD)
git fetch -q "$2" HEAD
mb=$(git merge-base "$rep" FETCH_HEAD || git hash-object -t tree /dev/null)
git diff "$mb" FETCH_HEAD
git checkout -q --detach FETCH_HEAD
git rebase -q "$rep" >&2 || exit ${CONFLICT}
git push -q origin HEAD:refs/heads/main`;

// $1 remote, $2 prompt. Runs Claude Code on a clone, commits, pushes, writes changed files.
const AGENT_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
base=$(git rev-parse -q --verify HEAD || true)
claude --print --dangerously-skip-permissions --no-session-persistence --model "$MODEL" -- "$2"
git add -A
git commit -qm "$2" || true
git push -q origin HEAD:refs/heads/main
${FILES_SH} > ${TASK}/files`;

// Detach from the exec so the task outlives the request; exit code lands atomically in $TASK/exit.
const BG_SH = `setsid bash -c "$0" agent "$@" >${TASK}/log 2>&1; echo $? >${TASK}/exit.tmp && mv ${TASK}/exit.tmp ${TASK}/exit`;

export type Run = { exitCode: number; stdout: string; stderr: string };
export type AgentJob = { repo: string; fork: string; remote: string; prompt: string };

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

// One Linux sandbox. RepoDO uses one per repo for git work; each agent gets its own.
export class Box extends DurableObject<Env> {
	private setup?: Promise<void>;

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

	async sh(script: string, args: string[] = []): Promise<Run> {
		await this.start();
		const p = await this.container.exec(["bash", "-c", script, "sh", ...args], {
			cwd: "/workspace",
			env: { ...TRUST, ...GIT_ID },
		});
		const out = await p.output();
		const dec = new TextDecoder();
		return { exitCode: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
	}

	async startAgent(job: AgentJob): Promise<void> {
		await this.start();
		await this.sh(`rm -rf ${TASK} && mkdir -p ${TASK}`);
		await this.container.exec(["bash", "-c", BG_SH, AGENT_SH, job.remote, job.prompt], {
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
		this.ctx.storage.kv.put("job", { ...job, remote: "" }); // don't persist the token
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
		const files = (await this.sh(`cat ${TASK}/files`)).stdout.split("\n").filter(Boolean);
		await this.env.REPO.getByName(job.repo).place(job.fork, files);
		await this.finish(job, "placed", log);
	}

	private async finish(job: AgentJob, status: string, log: string) {
		if (status !== "placed") await this.env.ARTIFACTS.delete(job.fork);
		this.ctx.storage.kv.delete("job");
		await this.env.REPO.getByName(job.repo).agentDone(job.fork, status, log);
		this.ctx.storage.kv.put("status", status);
		this.ctx.storage.kv.put("log", log);
		await this.container.destroy().catch(() => {});
	}
}
