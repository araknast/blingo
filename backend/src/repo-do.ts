import { DurableObject } from "cloudflare:workers";
import { CONFLICT, FERGE_SH, NO_CONFLICT, PLACE_SH, REBASE_SH, authRemote } from "./box";
import { conflictKey, fits, nearestNeighbour, renameConflicts, zeroDistanceJoins, type Bubble } from "./bubbles";

const POLL_MS = 5_000;

type Fork = { name: string; bubble: string; status: "rep" | "pending" | "merged" | "conflict"; files: string };
type Watch = { fork: string; base: string; token: string; expires: number };
type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null };

// One per blingo repository. All placement and merging for the repo is serialized here.
// ponytail: one merge at a time per repo (alarm is single-flight); per-bubble parallelism if it gets slow.
export class RepoDO extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Bubble id == name of its representative fork.
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS bubble(id TEXT PRIMARY KEY, visible INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fork(name TEXT PRIMARY KEY, bubble TEXT NOT NULL, status TEXT NOT NULL, files TEXT NOT NULL, diff TEXT);
			CREATE TABLE IF NOT EXISTS conflict(k TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS locked(id TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS watch(fork TEXT PRIMARY KEY, base TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_run(fork TEXT PRIMARY KEY, prompt TEXT NOT NULL, started INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'running', finished INTEGER, log TEXT);
		`);
	}

	// ---- RPC ----

	// A finished fork looks for a bubble (design: "finds a bubble to place the fork in").
	// One Box job checks the visible bubbles in order: the fork joins the first one none of whose
	// files it would bring into that bubble's rep. Otherwise it starts a new bubble whose files are
	// everything it carries since the repository's starting point.
	async place(fork: string): Promise<string> {
		const candidates = this.bubbles().filter((b) => b.visible);
		const [self, ...reps] = await Promise.all([fork, ...candidates.map((b) => b.id)].map((n) => authRemote(this.env, n, "read")));
		const args = candidates.flatMap((b, i) => [reps[i].url, [...b.files].join("\n")]);
		const r = await this.box().sh(PLACE_SH, [self.url, ...args]);
		if (r.exitCode !== 0) throw new Error(`placing ${fork} (${r.exitCode}): ${r.stderr}`);
		const [which, ...files] = r.stdout.split("\n").filter(Boolean);
		if (which !== "new") {
			// Re-read after the await: the bubble may have grown, been hidden, or been absorbed.
			const b = this.bubbles().find((h) => h.id === candidates[Number(which)].id);
			if (!b || !fits(b, files)) return this.place(fork); // changed under us; check again
			this.sql.exec("INSERT INTO fork (name, bubble, status, files) VALUES (?, ?, 'pending', ?)", fork, b.id, JSON.stringify(files));
			await this.placed();
			return b.id;
		}
		this.sql.exec("INSERT INTO bubble VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble))", fork);
		this.sql.exec("INSERT INTO fork (name, bubble, status, files) VALUES (?, ?, 'rep', ?)", fork, fork, JSON.stringify(files));
		await this.placed();
		return fork;
	}

	private async placed() {
		this.joinZeroDistance();
		await this.kick();
	}

	// Notagent: wait for one push to `fork`, then revoke its token and place it.
	async watch(fork: string, base: string, token: string, expires: number): Promise<void> {
		this.sql.exec("INSERT INTO watch VALUES (?, ?, ?, ?)", fork, base, token, expires);
		await this.kick();
	}

	// Source repo to fork from: a bubble's representative.
	repOf(bubble: string): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM bubble WHERE id = ?", bubble).toArray()[0]?.id ?? null;
	}

	lock(id: string): boolean {
		if (!this.repOf(id)) return false;
		this.sql.exec("INSERT OR IGNORE INTO locked VALUES (?)", id);
		return true;
	}

	async unlock(id: string): Promise<boolean> {
		if (!this.repOf(id)) return false;
		this.sql.exec("DELETE FROM locked WHERE id = ?", id);
		this.joinZeroDistance();
		await this.kick();
		return true;
	}

	// Ferge (design.md): reconcile two conflicting bubbles. b's changes minus the conflicting files go
	// into a; a new locked bubble holds those files with conflict markers. a and b are hidden meanwhile.
	// ponytail: not serialized with the alarm's merges; a member rebase pushing to a mid-ferge fails one of them.
	async ferge(repo: string, a: string, b: string): Promise<{ bubble: string; locked: string; files: string[] } | { error: string }> {
		if (!this.sql.exec("SELECT 1 FROM conflict WHERE k = ?", conflictKey(a, b)).toArray().length) {
			return { error: "those bubbles are not marked conflicting" };
		}
		const pair = this.bubbles().filter((h) => h.id === a || h.id === b);
		if (pair.length !== 2 || pair.some((h) => !h.visible || h.locked)) {
			return { error: "both bubbles must exist, be visible and be unlocked" };
		}
		const l = `${repo}-f-${crypto.randomUUID().slice(0, 8)}`;
		let done = false;
		this.sql.exec("UPDATE bubble SET visible = 0 WHERE id IN (?, ?)", a, b);
		try {
			{
				using rep = await this.env.ARTIFACTS.get(a);
				await rep.fork(l, { defaultBranchOnly: true });
			}
			const [ra, rb, rl] = await Promise.all([
				authRemote(this.env, a, "write"),
				authRemote(this.env, b, "read"),
				authRemote(this.env, l, "write"),
			]);
			const r = await this.box().sh(FERGE_SH, [ra.url, rb.url, rl.url]);
			if (r.exitCode === NO_CONFLICT) return { error: "those bubbles no longer conflict" };
			if (r.exitCode !== 0) throw new Error(`ferge ${b} → ${a} failed (${r.exitCode}): ${r.stderr}`);
			const [files, tree] = r.stdout.split(/^==$/m).map((s) => s.split("\n").filter(Boolean));
			this.absorb(a, b);
			this.sql.exec("UPDATE fork SET status = 'merged' WHERE name = ?", b);
			this.sql.exec("DELETE FROM conflict WHERE k = ?", conflictKey(a, b));
			this.sql.exec("INSERT INTO bubble VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble))", l);
			this.sql.exec("INSERT INTO fork (name, bubble, status, files) VALUES (?, ?, 'rep', ?)", l, l, JSON.stringify(tree));
			this.sql.exec("INSERT INTO locked VALUES (?)", l);
			done = true;
			await this.env.ARTIFACTS.delete(b);
			return { bubble: a, locked: l, files };
		} finally {
			if (!done) await this.env.ARTIFACTS.delete(l).catch(() => false);
			this.sql.exec("UPDATE bubble SET visible = 1 WHERE id IN (?, ?)", a, b);
			this.joinZeroDistance();
			await this.kick();
		}
	}

	// Any bubble to fork when none is named (visible first, oldest first); null if the repo has none yet.
	anyBubble(): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM bubble ORDER BY visible DESC, seq LIMIT 1").toArray()[0]?.id ?? null;
	}

	list() {
		const forks = this.sql.exec<Fork>("SELECT name, bubble, status, files FROM fork").toArray();
		return {
			bubbles: this.bubbles().map((h) => ({
				id: h.id,
				visible: h.visible,
				locked: !!h.locked,
				members: forks.filter((f) => f.bubble === h.id).map((f) => ({ ...f, files: JSON.parse(f.files) })),
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

	// Repo holding `fork`'s version of its files: its own, or its bubble rep once merged (and deleted).
	readFrom(fork: string): string | null {
		const f = this.sql.exec<Fork>("SELECT bubble, status FROM fork WHERE name = ?", fork).toArray()[0];
		return f ? (f.status === "merged" ? f.bubble : fork) : null;
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
		this.sql.exec("DELETE FROM bubble; DELETE FROM fork; DELETE FROM conflict; DELETE FROM locked; DELETE FROM watch; DELETE FROM agent_run;");
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
				await this.place(w.fork); // may throw; the watch stays so the alarm retries
				this.sql.exec("DELETE FROM watch WHERE fork = ?", w.fork);
			} else if (Date.now() > w.expires) {
				this.sql.exec("DELETE FROM watch WHERE fork = ?", w.fork);
				await this.env.ARTIFACTS.delete(w.fork);
			}
		}
	}

	// One unit of git work: merge a pending member into its rep, else merge a fully-merged bubble
	// with its nearest neighbour. Returns whether anything was attempted.
	private async mergeStep(): Promise<boolean> {
		const bubbles = this.bubbles();
		for (const h of bubbles.filter((h) => h.visible)) {
			const pending = this.sql
				.exec<{ name: string }>("SELECT name FROM fork WHERE bubble = ? AND status = 'pending' LIMIT 1", h.id)
				.toArray()[0];
			if (!pending) continue;
			const r = await this.rebase(h.id, pending.name);
			this.sql.exec("UPDATE fork SET status = ?, diff = ? WHERE name = ?", r.ok ? "merged" : "conflict", r.diff, pending.name);
			if (r.ok) await this.env.ARTIFACTS.delete(pending.name);
			return true;
		}

		const conflicts = new Set(this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k));
		for (const h of bubbles.filter((h) => h.visible)) {
			const nb = nearestNeighbour(h.id, bubbles, conflicts);
			if (!nb) continue;
			// Both invisible to placement while the merge runs.
			this.sql.exec("UPDATE bubble SET visible = 0 WHERE id IN (?, ?)", h.id, nb);
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
				this.sql.exec("UPDATE bubble SET visible = 1 WHERE id IN (?, ?)", h.id, nb);
			}
			this.joinZeroDistance(); // a bubble that just became visible may be at distance 0 to another
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
		this.sql.exec("UPDATE fork SET bubble = ? WHERE bubble = ?", into, from);
		this.sql.exec("UPDATE fork SET status = 'pending' WHERE name = ? AND status = 'rep'", from);
		this.sql.exec("DELETE FROM bubble WHERE id = ?", from);
		// Its conflicts carry over, so they stay ferge-able and aren't rediscovered by a wasted rebase.
		const keys = this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k);
		this.sql.exec("DELETE FROM conflict");
		for (const k of renameConflicts(keys, from, into)) this.sql.exec("INSERT INTO conflict VALUES (?)", k);
	}

	private joinZeroDistance() {
		for (const [into, from] of zeroDistanceJoins(this.bubbles())) this.absorb(into, from);
	}

	private bubbles(): Bubble[] {
		const files = new Map<string, Set<string>>();
		for (const f of this.sql.exec<{ bubble: string; files: string }>("SELECT bubble, files FROM fork").toArray()) {
			const s = files.get(f.bubble) ?? new Set();
			for (const p of JSON.parse(f.files) as string[]) s.add(p);
			files.set(f.bubble, s);
		}
		return this.sql
			.exec<{ id: string; visible: number; locked: number }>(
				"SELECT id, visible, id IN (SELECT id FROM locked) AS locked FROM bubble ORDER BY seq",
			)
			.toArray()
			.map((h) => ({ id: h.id, visible: !!h.visible, locked: !!h.locked, files: files.get(h.id) ?? new Set() }));
	}

	private box() {
		return this.env.BOX.getByName(`git-${this.ctx.id}`);
	}
}
