import { DurableObject } from "cloudflare:workers";
import { CHANGED_FILES_SH, CONFLICT, REBASE_SH, authRemote } from "./box";
import { conflictKey, nearestNeighbour, placeFork, zeroDistanceJoins, type Huddle } from "./huddles";

const POLL_MS = 5_000;

type Fork = { name: string; huddle: string; status: "rep" | "pending" | "merged" | "conflict"; files: string };
type Watch = { fork: string; base: string; token: string; expires: number };
type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null };

// One per blingo repository. All placement and merging for the repo is serialized here.
// ponytail: one merge at a time per repo (alarm is single-flight); per-huddle parallelism if it gets slow.
export class RepoDO extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.init();
	}

	private init() {
		// Huddle id == name of its representative fork.
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS huddle(id TEXT PRIMARY KEY, visible INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fork(name TEXT PRIMARY KEY, huddle TEXT NOT NULL, status TEXT NOT NULL, files TEXT NOT NULL, diff TEXT);
			CREATE TABLE IF NOT EXISTS conflict(k TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS watch(fork TEXT PRIMARY KEY, base TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL);
			DROP TABLE IF EXISTS agent; -- replaced by agent_run, which keeps finished runs
			CREATE TABLE IF NOT EXISTS agent_run(fork TEXT PRIMARY KEY, prompt TEXT NOT NULL, started INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'running', finished INTEGER, log TEXT);
		`);
	}

	// ---- RPC ----

	// A finished fork looks for a huddle (design: "finds a huddle to place the fork in").
	async place(fork: string, files: string[]): Promise<string> {
		const target = placeFork(this.huddles(), files);
		if (target) {
			this.sql.exec("INSERT INTO fork (name, huddle, status, files) VALUES (?, ?, 'pending', ?)", fork, target, JSON.stringify(files));
		} else {
			this.sql.exec("INSERT INTO huddle VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM huddle))", fork);
			this.sql.exec("INSERT INTO fork (name, huddle, status, files) VALUES (?, ?, 'rep', ?)", fork, fork, JSON.stringify(files));
		}
		this.joinZeroDistance();
		await this.kick();
		return target ?? fork;
	}

	// Notagent: wait for one push to `fork`, then revoke its token and place it.
	async watch(fork: string, base: string, token: string, expires: number): Promise<void> {
		this.sql.exec("INSERT INTO watch VALUES (?, ?, ?, ?)", fork, base, token, expires);
		await this.kick();
	}

	// Source repo to fork from: a huddle's representative.
	repOf(huddle: string): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM huddle WHERE id = ?", huddle).toArray()[0]?.id ?? null;
	}

	// Any huddle to fork when none is named (visible first, oldest first); null if the repo has none yet.
	anyHuddle(): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM huddle ORDER BY visible DESC, seq LIMIT 1").toArray()[0]?.id ?? null;
	}

	list() {
		const forks = this.sql.exec<Fork>("SELECT name, huddle, status, files FROM fork").toArray();
		return {
			huddles: this.sql
				.exec<{ id: string; visible: number }>("SELECT id, visible FROM huddle ORDER BY seq")
				.toArray()
				.map((h) => ({
					id: h.id,
					visible: !!h.visible,
					members: forks.filter((f) => f.huddle === h.id).map((f) => ({ ...f, files: JSON.parse(f.files) })),
				})),
			conflicts: this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k.split("|")),
			waiting: this.sql.exec<{ fork: string }>("SELECT fork FROM watch").toArray().map((r) => r.fork),
			// Running first, then the most recent finished runs.
			agents: this.sql
				.exec<AgentRun>("SELECT * FROM agent_run ORDER BY status = 'running' DESC, started DESC LIMIT 50")
				.toArray(),
		};
	}

	// Agent runs on forks of this repo; kept after they finish so failures stay visible.
	agentStarted(fork: string, prompt: string) {
		this.sql.exec("INSERT INTO agent_run (fork, prompt, started) VALUES (?, ?, ?)", fork, prompt, Date.now());
	}

	agentDone(fork: string, status: string, log: string) {
		this.sql.exec("UPDATE agent_run SET status = ?, finished = ?, log = ? WHERE fork = ?", status, Date.now(), log, fork);
	}

	// Repo holding `fork`'s version of its files: its own, or its huddle rep once merged (and deleted).
	readFrom(fork: string): string | null {
		const f = this.sql.exec<Fork>("SELECT huddle, status FROM fork WHERE name = ?", fork).toArray()[0];
		return f ? (f.status === "merged" ? f.huddle : fork) : null;
	}

	diff(fork: string): string | null {
		return this.sql.exec<{ diff: string | null }>("SELECT diff FROM fork WHERE name = ?", fork).toArray()[0]?.diff ?? null;
	}

	// Deletes the git repos this repository still owns (base, reps, unmerged and watched forks;
	// merged forks are already gone), then every record. Already-missing repos are skipped.
	async destroy(repo: string): Promise<string[]> {
		const names = new Set([
			repo,
			...this.sql.exec<{ name: string }>("SELECT name FROM fork WHERE status != 'merged'").toArray().map((r) => r.name),
			...this.sql.exec<{ fork: string }>("SELECT fork FROM watch").toArray().map((r) => r.fork),
		]);
		const deleted: string[] = [];
		for (const n of names) {
			try {
				if (await this.env.ARTIFACTS.delete(n)) deleted.push(n);
			} catch (e) {
				if (!String(e).includes("NOT_FOUND")) throw e;
			}
		}
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.init(); // this instance stays alive, so recreate the empty tables
		return deleted;
	}

	// ---- representative loop ----

	async alarm(): Promise<void> {
		await this.pollWatches();
		const worked = await this.mergeStep();
		const watching = this.sql.exec("SELECT 1 FROM watch").toArray().length > 0;
		if (worked) await this.ctx.storage.setAlarm(Date.now() + 1_000);
		else if (watching) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
	}

	private async kick() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	// ponytail: polling, because a per-fork Artifacts event subscription is more setup than a 5s poll.
	// Pushes landing inside one poll window all count as "the" push.
	private async pollWatches() {
		for (const w of this.sql.exec<Watch>("SELECT * FROM watch").toArray()) {
			using repo = await this.env.ARTIFACTS.get(w.fork);
			const head = (await repo.log({ limit: 1 }))[0]?.hash ?? "";
			if (head !== w.base) {
				await repo.revokeToken(w.token); // "shuts down the git server"
				const { url } = await authRemote(this.env, w.fork, "read");
				const r = await this.box().sh(CHANGED_FILES_SH, [url, w.base]);
				if (r.exitCode !== 0) throw new Error(`changed files: ${r.stderr}`);
				this.sql.exec("DELETE FROM watch WHERE fork = ?", w.fork);
				await this.place(w.fork, r.stdout.split("\n").filter(Boolean));
			} else if (Date.now() > w.expires) {
				this.sql.exec("DELETE FROM watch WHERE fork = ?", w.fork);
				await this.env.ARTIFACTS.delete(w.fork);
			}
		}
	}

	// One unit of git work: merge a pending member into its rep, else merge a fully-merged huddle
	// with its nearest neighbour. Returns whether anything was attempted.
	private async mergeStep(): Promise<boolean> {
		const huddles = this.huddles();
		for (const h of huddles.filter((h) => h.visible)) {
			const pending = this.sql
				.exec<{ name: string }>("SELECT name FROM fork WHERE huddle = ? AND status = 'pending' LIMIT 1", h.id)
				.toArray()[0];
			if (!pending) continue;
			const r = await this.rebase(h.id, pending.name);
			this.sql.exec("UPDATE fork SET status = ?, diff = ? WHERE name = ?", r.ok ? "merged" : "conflict", r.diff, pending.name);
			if (r.ok) await this.env.ARTIFACTS.delete(pending.name);
			return true;
		}

		const conflicts = new Set(this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k));
		for (const h of huddles.filter((h) => h.visible)) {
			const nb = nearestNeighbour(h.id, huddles, conflicts);
			if (!nb) continue;
			// Both invisible to placement while the merge runs.
			this.sql.exec("UPDATE huddle SET visible = 0 WHERE id IN (?, ?)", h.id, nb);
			try {
				const r = await this.rebase(h.id, nb);
				if (r.ok) {
					this.absorb(h.id, nb);
					this.sql.exec("UPDATE fork SET status = 'merged', diff = ? WHERE name = ?", r.diff, nb);
					await this.env.ARTIFACTS.delete(nb);
				} else {
					this.sql.exec("INSERT OR IGNORE INTO conflict VALUES (?)", conflictKey(h.id, nb));
				}
			} finally {
				this.sql.exec("UPDATE huddle SET visible = 1 WHERE id IN (?, ?)", h.id, nb);
			}
			this.joinZeroDistance(); // a huddle that just became visible may be at distance 0 to another
			return true;
		}
		return false;
	}

	// Rebase `src` onto rep `into` in the sandbox. Conflict → ok:false; infra error → throws (alarm retries).
	private async rebase(into: string, src: string): Promise<{ ok: boolean; diff: string | null }> {
		const [rep, from] = await Promise.all([authRemote(this.env, into, "write"), authRemote(this.env, src, "read")]);
		const r = await this.box().sh(REBASE_SH, [rep.url, from.url]);
		if (r.exitCode === 0) return { ok: true, diff: r.stdout };
		if (r.exitCode === CONFLICT) return { ok: false, diff: r.stdout };
		throw new Error(`rebase ${src} → ${into} failed (${r.exitCode}): ${r.stderr}`);
	}

	// Set-join: `from`'s members move into `into`; `from`'s rep becomes a pending member so its
	// content gets rebased into `into`'s rep (disjoint files, so it can't textually conflict).
	private absorb(into: string, from: string) {
		this.sql.exec("UPDATE fork SET huddle = ? WHERE huddle = ?", into, from);
		this.sql.exec("UPDATE fork SET status = 'pending' WHERE name = ? AND status = 'rep'", from);
		this.sql.exec("DELETE FROM huddle WHERE id = ?", from);
	}

	private joinZeroDistance() {
		for (const [into, from] of zeroDistanceJoins(this.huddles())) this.absorb(into, from);
	}

	private huddles(): Huddle[] {
		const files = new Map<string, Set<string>>();
		for (const f of this.sql.exec<{ huddle: string; files: string }>("SELECT huddle, files FROM fork").toArray()) {
			const s = files.get(f.huddle) ?? new Set();
			for (const p of JSON.parse(f.files) as string[]) s.add(p);
			files.set(f.huddle, s);
		}
		return this.sql
			.exec<{ id: string; visible: number }>("SELECT id, visible FROM huddle ORDER BY seq")
			.toArray()
			.map((h) => ({ id: h.id, visible: !!h.visible, files: files.get(h.id) ?? new Set() }));
	}

	private box() {
		return this.env.BOX.getByName(`git-${this.ctx.id}`);
	}
}
