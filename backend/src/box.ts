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

// $1 fork remote, then pairs of (bubble rep remote, that bubble's files newline-separated), in order.
// For each bubble: the files the fork would bring into its rep = changed since their merge base, so
// history the fork carries from elsewhere counts. Stops at the first bubble none of whose files are
// in that set and prints its index, then the set. If none fits, prints "new", then every file
// changed since the repository's starting point (the new bubble's files).
// ponytail: base repos are always created empty, so "starting point" = the empty tree; diff
// against the base repo's head instead if repos can ever be imported.
export const PLACE_SH = `set -e
d=$(mktemp -d); git clone -q "$1" "$d"; cd "$d"; shift
empty=$(git hash-object -t tree /dev/null)
i=0
while [ $# -ge 2 ]; do
	git fetch -q "$1" HEAD
	brings=$(git diff --name-only "$(git merge-base FETCH_HEAD HEAD || echo "$empty")" HEAD)
	if ! printf '%s\\n' "$brings" | grep -qFxf <(printf '%s\\n' "$2" | sed '/^$/d'); then
		echo "$i"; printf '%s\\n' "$brings"; exit 0
	fi
	i=$((i + 1)); shift 2
done
echo new
git diff --name-only "$empty" HEAD`;

// $1 rep remote (write), then source remotes (read): a bubble's pending members, or one neighbour
// bubble's rep. Merges them all into the rep with one merge commit (an octopus when there are
// several). If that fails, merges them one at a time so a source that conflicts doesn't block the
// rest. Pushes once. Prints "== <i> ok|conflict" then that source's diff, per source, in order.
// Exit 0 even with conflicts; anything else = infra error.
export const MERGE_SH = `set -e
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
git clone -q "$1" "$d"; cd "$d"; rep=$(git rev-parse HEAD); shift
n=0; for src in "$@"; do git fetch -q "$src" "+HEAD:refs/m/$n"; n=$((n + 1)); done
merge() { msg=$1; shift; git merge -q --no-ff --no-edit --allow-unrelated-histories -m "$msg" "$@" >&2; }
st=()
if merge "merge $n forks" $(seq -f 'refs/m/%g' 0 $((n - 1))); then
	for i in $(seq 0 $((n - 1))); do st[$i]=ok; done
else
	git merge --abort 2>/dev/null || true; git reset -q --hard "$rep"
	for i in $(seq 0 $((n - 1))); do
		if merge "merge fork" "refs/m/$i"; then st[$i]=ok
		else git merge --abort 2>/dev/null || git reset -q --hard HEAD; st[$i]=conflict; fi
	done
fi
[ "$(git rev-parse HEAD)" = "$rep" ] || git push -q origin HEAD:refs/heads/main
empty=$(git hash-object -t tree /dev/null)
for i in $(seq 0 $((n - 1))); do
	echo "== $i \${st[$i]}"
	git diff "$(git merge-base "$rep" "refs/m/$i" || echo "$empty")" "refs/m/$i"
done`;

export const NO_CONFLICT = 11;

// Ferge. $1 bubble A rep (write), $2 bubble B rep (read), $3 new locked bubble L (write, a fork of A).
// A ← A + B with the conflicting files removed (one squashed commit, history stays linear).
// L ← that + the conflicting files with conflict markers. Prints the conflicting files, a "==" line,
// then every file in L's tree (L's file set: everything it carries since the repo's starting point).
// Exit ${NO_CONFLICT} = A and B no longer conflict; anything else nonzero = infra error.
export const FERGE_SH = `set -e
d=$(mktemp -d); m=$(mktemp -d); git clone -q "$1" "$d"; cd "$d"
a=$(git rev-parse HEAD)
git fetch -q "$2" HEAD; b=$(git rev-parse FETCH_HEAD)
mt() { git merge-tree --write-tree --no-messages --allow-unrelated-histories "$@"; }
out=$(mt --name-only "$a" "$b") && rc=0 || rc=$?
[ "$rc" -le 1 ] || exit "$rc"
F=$(printf '%s\\n' "$out" | tail -n +2)
[ -n "$F" ] || exit ${NO_CONFLICT}
# Capture each conflicting file as git leaves it mid-merge: with conflict markers.
git -c merge.conflictStyle=merge merge -q --no-commit --no-ff --allow-unrelated-histories "$b" >/dev/null 2>&1 || true
printf '%s\\n' "$F" | while IFS= read -r f; do
	if [ -e "$f" ]; then mkdir -p "$m/$(dirname "$f")"; cp "$f" "$m/$f"; fi
done
git merge --abort 2>/dev/null || git reset -q --hard "$a"
drop() {
	git checkout -q --detach "$1"
	printf '%s\\n' "$F" | git --literal-pathspecs rm -q --ignore-unmatch --pathspec-from-file=-
	git commit -q --allow-empty -m "ferge: remove conflicting files"
	git rev-parse HEAD
}
ap=$(drop "$a"); bp=$(drop "$b")
t=$(mt "$ap" "$bp") # its own assignment, so set -e catches a failed merge
c=$(git commit-tree "$t" -p "$ap" -m "ferge: merge $b without conflicting files")
git push -q origin "$c:refs/heads/main"
git checkout -q --detach "$c"
cp -R "$m/." .
git add -A
git commit -q --allow-empty -m "ferge: conflicting files with conflict markers"
git push -q "$3" HEAD:refs/heads/main
printf '%s\\n' "$F" ==
git ls-files`;

// $1 remote, $2 prompt. Runs Claude Code on a clone, commits, pushes, writes changed files.
const AGENT_SH = `set -e
rm -rf /workspace/repo; git clone -q "$1" /workspace/repo; cd /workspace/repo
claude --print --dangerously-skip-permissions --no-session-persistence --model "$MODEL" -- "$2"
git add -A
git commit -qm "$2" || true
git push -q origin HEAD:refs/heads/main`;

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
		await this.env.REPO.getByName(job.repo).place(job.fork);
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
