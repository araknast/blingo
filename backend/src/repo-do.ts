import { DurableObject } from "cloudflare:workers";
import { authRemote, forkRepo, headOf } from "./box";
import { MERGES, PATCH_SH, readSeries } from "./git-scripts";
import { conflictKey, nearestNeighbour, placeFork, renameConflicts, type Basis, type Bubble } from "./bubbles";
import { explanation, ready, renameOwed, shortTitle, type Owed, type PlanItem, type TaskState } from "./tasks";

const POLL_MS = 5_000;
// A merge or ferge hides its bubbles for seconds. Longer than the alarm's own wall-clock limit means
// the operation died (cancelled alarm, reset, deploy) without un-hiding them.
const HIDE_LEASE_MS = 15 * 60_000;
// ponytail: a fork's patch series is kept in SQLite (2 MB rows); store series in R2 if forks get bigger.
const MAX_SERIES = 1_500_000;

// status: rep = the fork that started the bubble; pending = its patch series is queued; merged = applied
// (or merged in, for forks from before patch series); failed = its series didn't apply; conflict = a
// pre-patch-series fork that didn't merge. `seq` orders applied series (see Basis).
type Fork = { name: string; bubble: string; status: "rep" | "pending" | "merged" | "conflict" | "failed"; files: string; seq: number | null };
type Watch = { fork: string; base: string; token: string; expires: number };
type AgentRun = { fork: string; prompt: string; started: number; status: string; finished: number | null; log: string | null };
type TaskRow = TaskState & {
	title: string;
	description: string;
	kind: "agent" | "notagent";
	base_head: string | null;
	explanation: string | null;
	superagent: string | null;
	created: number;
	finished: number | null;
};
// A task to add: a superagent's plan item (deps by key within the batch), or one from the API.
export type NewTask = Omit<PlanItem, "key"> & { key?: string; bubble?: string | null };

// One per blingo repository: placement, the bubbles' patch queues and bubble merges. Each bubble's rep
// is written only by that bubble's own Box (see Box.rep), which applies its queue and runs its merges.
// ponytail: one neighbour merge at a time per repo (alarm is single-flight); disjoint pairs could run in parallel.
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
			CREATE TABLE IF NOT EXISTS hidden(id TEXT PRIMARY KEY, since INTEGER NOT NULL); -- lease for bubble.visible = 0
			CREATE TABLE IF NOT EXISTS watch(fork TEXT PRIMARY KEY, base TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS pushed(fork TEXT PRIMARY KEY); -- watched forks whose push arrived, not yet placed
			CREATE TABLE IF NOT EXISTS agent_run(fork TEXT PRIMARY KEY, prompt TEXT NOT NULL, started INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'running', finished INTEGER, log TEXT);
			-- bubble: where an open task without deps starts (NULL = any); once started, where it did.
			CREATE TABLE IF NOT EXISTS task(id TEXT PRIMARY KEY, description TEXT NOT NULL, kind TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open', bubble TEXT, fork TEXT, base_head TEXT, explanation TEXT,
				superagent TEXT, created INTEGER NOT NULL, finished INTEGER, title TEXT NOT NULL DEFAULT '');
			CREATE TABLE IF NOT EXISTS task_dep(task TEXT NOT NULL, dep TEXT NOT NULL, PRIMARY KEY (task, dep));
			CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY, text TEXT NOT NULL, author TEXT NOT NULL, created INTEGER NOT NULL);
			-- a ferge's locked bubble still owes its conflicting files to bubble "into"
			CREATE TABLE IF NOT EXISTS owed(locked TEXT NOT NULL, "into" TEXT NOT NULL, PRIMARY KEY (locked, "into"));
			-- where an unplaced fork started (bubble NULL = the empty base repo); see Basis
			CREATE TABLE IF NOT EXISTS basis(fork TEXT PRIMARY KEY, bubble TEXT, epoch INTEGER NOT NULL, seq INTEGER NOT NULL);
			-- absorbed bubbles, so a fork's basis can be followed to the bubble holding its code now
			CREATE TABLE IF NOT EXISTS renamed("from" TEXT PRIMARY KEY, "into" TEXT NOT NULL);
			-- bubble pairs in a neighbour merge or ferge, for the map
			CREATE TABLE IF NOT EXISTS merging(a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
		`);
		// Tasks from before titles: add the column in place and title them from their descriptions.
		if (this.addColumn("task", "title", "TEXT NOT NULL DEFAULT ''")) {
			for (const t of this.sql.exec<{ id: string; description: string }>("SELECT id, description FROM task").toArray()) {
				this.sql.exec("UPDATE task SET title = ? WHERE id = ?", shortTitle(t.description), t.id);
			}
		}
		// Patch series: bubbles count their code changes; forks record the order their series applied.
		this.addColumn("bubble", "epoch", "INTEGER NOT NULL DEFAULT 0");
		this.addColumn("bubble", "ferge", "INTEGER NOT NULL DEFAULT 0");
		this.addColumn("fork", "seq", "INTEGER");
		// A fresh instance means any merge or ferge that hid bubbles died with the old one.
		if (this.recoverHidden(true)) void ctx.blockConcurrencyWhile(() => this.kick());
	}

	// Adds a column to a live table if it isn't there yet; returns whether it was added.
	private addColumn(table: string, column: string, decl: string): boolean {
		if (this.sql.exec("SELECT 1 FROM pragma_table_info(?) WHERE name = ?", table, column).toArray().length) return false;
		this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
		return true;
	}

	private hide(a: string, b: string) {
		for (const id of [a, b]) {
			this.sql.exec("UPDATE bubble SET visible = 0 WHERE id = ?", id);
			this.sql.exec("INSERT OR REPLACE INTO hidden (id, since) VALUES (?, ?)", id, Date.now());
		}
		this.sql.exec("INSERT OR IGNORE INTO merging (a, b) VALUES (?, ?)", a, b);
	}

	private show(...ids: string[]) {
		for (const id of ids) {
			this.sql.exec("UPDATE bubble SET visible = 1 WHERE id = ?", id);
			this.sql.exec("DELETE FROM hidden WHERE id = ?", id);
			this.sql.exec("DELETE FROM merging WHERE a = ? OR b = ?", id, id);
		}
	}

	// Un-hide bubbles whose hiding operation died: all of them (`all`, for a fresh instance), or those
	// past their lease or with no lease row. Returns how many were un-hidden.
	private recoverHidden(all = false): number {
		const cutoff = all ? Number.MAX_SAFE_INTEGER : Date.now() - HIDE_LEASE_MS;
		const stuck = this.sql
			.exec<{ id: string }>("SELECT id FROM bubble WHERE visible = 0 AND id NOT IN (SELECT id FROM hidden WHERE since > ?)", cutoff)
			.toArray()
			.map((r) => r.id);
		this.show(...stuck);
		this.sql.exec("DELETE FROM hidden WHERE id NOT IN (SELECT id FROM bubble WHERE visible = 0)");
		this.sql.exec("DELETE FROM merging WHERE a NOT IN (SELECT id FROM hidden) OR b NOT IN (SELECT id FROM hidden)");
		return stuck.length;
	}

	// The order patch series applied in, across the repository.
	private seq = () => this.ctx.storage.kv.get<number>("seq") ?? 0;
	private nextSeq() {
		const n = this.seq() + 1;
		this.ctx.storage.kv.put("seq", n);
		return n;
	}

	// The bubble holding `id`'s code now, following absorptions.
	private resolve(id: string): string {
		for (let at = id, i = 0; i < 1000; i++) {
			const next = this.sql.exec<{ into: string }>('SELECT "into" FROM renamed WHERE "from" = ?', at).toArray()[0]?.into;
			if (!next) return at;
			at = next;
		}
		return id;
	}

	// Records where a fork about to be made from `from` (a bubble, or null = the base repo) starts.
	// Read before forking: a series applied meanwhile then only counts against the fork, never for it.
	private basisOf(from: string | null) {
		const epoch = from ? (this.sql.exec<{ epoch: number }>("SELECT epoch FROM bubble WHERE id = ?", from).toArray()[0]?.epoch ?? 0) : 0;
		return { bubble: from, epoch, seq: this.seq() };
	}
	private recordBasis(fork: string, b: { bubble: string | null; epoch: number; seq: number }) {
		this.sql.exec("INSERT OR REPLACE INTO basis (fork, bubble, epoch, seq) VALUES (?, ?, ?, ?)", fork, b.bubble, b.epoch, b.seq);
	}

	// ---- RPC ----

	// A finished fork's patch series (its changed `files` and `git format-patch` `mbox`) joins the queue of
	// the first bubble it applies to cleanly (placeFork), or starts a new bubble with the fork as its rep.
	// Nothing awaits between choosing the bubble and queueing, so concurrent placements can't collide; a
	// bubble with queued series is never merged away (mergeStep), so the series always reaches its rep.
	// The fork's task completes, explained by the series' commit messages. A fork that changed nothing
	// joins no bubble.
	async place(fork: string, files: string[], mbox: string): Promise<{ bubble: string | null } | { error: string }> {
		if (mbox.length > MAX_SERIES) return { error: `its patch series is over ${MAX_SERIES} bytes` };
		const b = this.sql.exec<{ bubble: string | null; epoch: number; seq: number }>("SELECT bubble, epoch, seq FROM basis WHERE fork = ?", fork).toArray()[0];
		const bubbles = this.bubbles();
		let target: string | null;
		let basisFiles = new Set<string>();
		if (!files.length) target = null;
		else if (!b) {
			// A fork from before bases were recorded: its code is unknown, so it starts its own bubble
			// that counts every file any bubble changed.
			target = "new";
			basisFiles = new Set(bubbles.flatMap((h) => [...h.files]));
		} else {
			const basis: Basis | null = b.bubble ? { bubble: b.bubble, epoch: b.epoch, seq: b.seq } : null;
			basisFiles = (b.bubble && bubbles.find((h) => h.id === this.resolve(b.bubble!))?.files) || new Set();
			target = placeFork(bubbles, files, basis, basisFiles);
			if (target === null) return { error: "it is a fix for a ferge bubble, and no longer applies there" };
		}
		this.sql.exec("DELETE FROM basis WHERE fork = ?", fork);
		if (target === "new") {
			this.sql.exec("INSERT INTO bubble (id, visible, seq) VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble))", fork);
			this.sql.exec(
				"INSERT INTO fork (name, bubble, status, files, diff, seq) VALUES (?, ?, 'rep', ?, ?, ?)",
				fork,
				fork,
				JSON.stringify([...new Set([...files, ...basisFiles])]),
				mbox,
				this.nextSeq(),
			);
		} else if (target) {
			this.sql.exec("INSERT INTO fork (name, bubble, status, files, diff) VALUES (?, ?, 'pending', ?, ?)", fork, target, JSON.stringify(files), mbox);
		}
		this.sql.exec(
			"UPDATE task SET status = 'completed', explanation = ?, finished = ? WHERE fork = ? AND status = 'in-progress'",
			explanation(mbox),
			Date.now(),
			fork,
		);
		// The series carries the fork's work now; its repo is only kept as a new bubble's rep.
		if (target !== "new") await this.env.ARTIFACTS.delete(fork).catch(() => false);
		await this.kick(); // applies the series; also schedules tasks this unblocks, once their deps land
		return { bubble: target === "new" ? fork : target };
	}

	// ---- tasks and memory (tasktracker.md) ----

	// Adds tasks (one superagent plan, or one task from the API). A dep names a key within the batch,
	// else an existing task's id. Returns their ids in order. `repo` is remembered so the alarm can
	// start agents.
	async addTasks(repo: string, items: NewTask[], superagent: string | null = null): Promise<{ ids: string[] } | { error: string }> {
		const ids = new Map(items.map((i, n) => [i.key ?? String(n), `t-${crypto.randomUUID().slice(0, 8)}`]));
		const dep = (d: string) => ids.get(d) ?? (this.sql.exec("SELECT 1 FROM task WHERE id = ?", d).toArray().length ? d : null);
		const unknown = items.flatMap((i) => i.deps).find((d) => !dep(d));
		if (unknown) return { error: `no such task: ${unknown}` };
		this.ctx.storage.kv.put("repo", repo);
		items.forEach((i, n) => {
			const id = ids.get(i.key ?? String(n))!;
			this.sql.exec(
				"INSERT INTO task (id, title, description, kind, bubble, superagent, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
				id,
				i.title,
				i.description,
				i.kind,
				i.bubble ?? null,
				superagent,
				Date.now(),
			);
			for (const d of i.deps) this.sql.exec("INSERT OR IGNORE INTO task_dep (task, dep) VALUES (?, ?)", id, dep(d));
		});
		await this.schedule();
		return { ids: [...ids.values()] };
	}

	task(id: string) {
		return this.sql.exec<Omit<TaskRow, "deps">>("SELECT * FROM task WHERE id = ?", id).toArray()[0] ?? null;
	}

	async retryTask(id: string): Promise<boolean> {
		const n = this.sql.exec("UPDATE task SET status = 'open', fork = NULL, finished = NULL WHERE id = ? AND status = 'failed'", id).rowsWritten;
		if (n) await this.schedule();
		return n > 0;
	}

	// A human takes an open notagent task: it gets a fork with a 1-hour push token. The task is back
	// to open if nothing is pushed in time.
	async takeTask(id: string) {
		const t = this.task(id);
		if (!t || t.kind !== "notagent" || t.status !== "open") return { error: "that task isn't an open notagent task" };
		const from = this.startable().get(id);
		if (from === undefined) return { error: "that task is waiting for its dependencies to merge" };
		const repo = this.ctx.storage.kv.get<string>("repo")!;
		this.sql.exec("UPDATE task SET status = 'in-progress', bubble = ? WHERE id = ?", from, id);
		try {
			const basis = this.basisOf(from);
			const fork = await forkRepo(this.env, from ?? repo, repo);
			this.recordBasis(fork, basis);
			const base = await headOf(this.env, fork);
			const { url: authed, remote, token } = await authRemote(this.env, fork, "write", 3600);
			this.sql.exec("UPDATE task SET fork = ?, base_head = ? WHERE id = ?", fork, base, id);
			this.sql.exec("INSERT INTO watch (fork, base, token, expires) VALUES (?, ?, ?, ?)", fork, base, token.id, Date.parse(token.expiresAt));
			await this.kick();
			return { repo, task: id, fork, remote, token: token.plaintext, clone: `git clone ${authed} ${fork}`, push: `git push ${authed} HEAD:main` };
		} catch (e) {
			this.sql.exec("UPDATE task SET status = 'open', fork = NULL WHERE id = ? AND status = 'in-progress'", id);
			throw e;
		}
	}

	async addMemory(texts: string[], author: string) {
		for (const text of texts) {
			this.sql.exec("INSERT INTO memory (id, text, author, created) VALUES (?, ?, ?, ?)", `m-${crypto.randomUUID().slice(0, 8)}`, text, author, Date.now());
		}
	}

	deleteMemory(id: string): boolean {
		return this.sql.exec("DELETE FROM memory WHERE id = ?", id).rowsWritten > 0;
	}

	memories(): string[] {
		return this.sql.exec<{ text: string }>("SELECT text FROM memory ORDER BY created").toArray().map((r) => r.text);
	}

	private tasks(): TaskRow[] {
		const deps = new Map<string, string[]>();
		for (const d of this.sql.exec<{ task: string; dep: string }>("SELECT task, dep FROM task_dep").toArray()) {
			deps.set(d.task, [...(deps.get(d.task) ?? []), d.dep]);
		}
		return this.sql.exec<Omit<TaskRow, "deps">>("SELECT * FROM task ORDER BY rowid" /* insertion order: a plan stays in its order */).toArray().map((t) => ({ ...t, deps: deps.get(t.id) ?? [] }));
	}

	// Open tasks that may start now → bubble to fork (null = base repo).
	private startable() {
		return ready(
			this.tasks(),
			this.sql.exec<{ name: string; bubble: string; status: string }>("SELECT name, bubble, status FROM fork").toArray(),
			this.bubbles(),
			this.sql.exec<Owed>('SELECT locked, "into" FROM owed').toArray(),
			this.anyBubble(),
		);
	}

	// Starts every ready agent task. Marked in-progress before the first await, so concurrent calls
	// don't start one twice; a start that fails goes back to open for the next call.
	private async schedule() {
		const repo = this.ctx.storage.kv.get<string>("repo");
		if (!repo) return;
		const memory = this.memories();
		const from = this.startable();
		const go = this.tasks().filter((t) => t.kind === "agent" && from.has(t.id));
		for (const t of go) this.sql.exec("UPDATE task SET status = 'in-progress', bubble = ? WHERE id = ?", from.get(t.id), t.id);
		await Promise.all(
			go.map(async (t) => {
				try {
					const basis = this.basisOf(from.get(t.id) ?? null);
					const fork = await forkRepo(this.env, from.get(t.id) ?? repo, repo);
					this.recordBasis(fork, basis);
					const base = await headOf(this.env, fork);
					this.sql.exec("UPDATE task SET fork = ?, base_head = ? WHERE id = ?", fork, base, t.id);
					const { url: remote } = await authRemote(this.env, fork, "write", 3 * 3600);
					const prompt = `# ${t.title}\n\n${t.description}`;
					await this.env.BOX.getByName(fork).startAgent({ repo, fork, remote, prompt, kind: "agent", memory });
					this.agentStarted(fork, t.title);
				} catch (e) {
					console.error(`starting task ${t.id}`, e);
					const fork = this.task(t.id)?.fork;
					if (fork) await this.env.ARTIFACTS.delete(fork).catch(() => false);
					this.sql.exec("UPDATE task SET status = 'open', fork = NULL WHERE id = ?", t.id);
					if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 30_000); // retry
				}
			}),
		);
	}

	// Source repo to fork from: a bubble's representative.
	repOf(bubble: string): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM bubble WHERE id = ?", bubble).toArray()[0]?.id ?? null;
	}

	lock(id: string): boolean {
		if (!this.repOf(id)) return false;
		this.sql.exec("INSERT OR IGNORE INTO locked (id) VALUES (?)", id);
		return true;
	}

	async unlock(id: string): Promise<boolean> {
		if (!this.repOf(id)) return false;
		this.sql.exec("DELETE FROM locked WHERE id = ?", id);
		await this.kick();
		return true;
	}

	// Ferge (design.md): reconcile two conflicting bubbles. b's changes minus the conflicting files go
	// into a; a new locked ferge bubble holds those files with conflict markers. Runs in a's Box (the
	// only writer of a's rep); a and b are hidden meanwhile, and both must have no queued series.
	async ferge(repo: string, a: string, b: string): Promise<{ bubble: string; locked: string; files: string[] } | { error: string }> {
		this.recoverHidden();
		if (!this.sql.exec("SELECT 1 FROM conflict WHERE k = ?", conflictKey(a, b)).toArray().length) {
			return { error: "those bubbles are not marked conflicting" };
		}
		const pair = this.bubbles().filter((h) => h.id === a || h.id === b);
		if (pair.length !== 2 || pair.some((h) => !h.visible || h.locked)) {
			return { error: "both bubbles must exist, be visible and be unlocked" };
		}
		if (this.busy().has(a) || this.busy().has(b)) return { error: "wait for the forks queued in those bubbles to land" };
		const l = `${repo}-f-${crypto.randomUUID().slice(0, 8)}`;
		let done = false;
		this.hide(a, b);
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
			const r = await this.bubbleBox(a).ferge(ra.url, rb.url, rl.url);
			if (!r) return { error: "those bubbles no longer conflict" };
			this.absorb(a, b);
			this.sql.exec("UPDATE fork SET status = 'merged', seq = ? WHERE name = ?", this.nextSeq(), b);
			this.sql.exec("DELETE FROM conflict WHERE k = ?", conflictKey(a, b));
			this.sql.exec("INSERT INTO bubble (id, visible, seq, ferge) VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble), 1)", l);
			this.sql.exec("INSERT INTO fork (name, bubble, status, files, seq) VALUES (?, ?, 'rep', ?, ?)", l, l, JSON.stringify(r.tree), this.nextSeq());
			this.sql.exec("INSERT INTO locked (id) VALUES (?)", l);
			this.sql.exec('INSERT OR IGNORE INTO owed (locked, "into") VALUES (?, ?)', l, a); // a lacks those files until l merges back
			done = true;
			await this.env.ARTIFACTS.delete(b);
			await this.bubbleBox(b).stop();
			return { bubble: a, locked: l, files: r.files };
		} finally {
			if (!done) await this.env.ARTIFACTS.delete(l).catch(() => false);
			this.show(a, b);
			await this.kick();
		}
	}

	// Any bubble to fork when none is named (visible first, oldest first); null if the repo has none yet.
	anyBubble(): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM bubble ORDER BY visible DESC, seq LIMIT 1").toArray()[0]?.id ?? null;
	}

	list() {
		const forks = this.sql.exec<Fork>("SELECT name, bubble, status, files FROM fork").toArray();
		const startable = this.startable();
		return {
			bubbles: this.bubbles().map((h) => ({
				id: h.id,
				visible: h.visible,
				locked: !!h.locked,
				members: forks.filter((f) => f.bubble === h.id).map((f) => ({ ...f, files: JSON.parse(f.files) })),
			})),
			conflicts: this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k.split("|")),
			merging: this.sql.exec<{ a: string; b: string }>("SELECT a, b FROM merging").toArray().map((r) => [r.a, r.b]),
			// Notagent forks still waiting for their push, and pushed ones still being placed.
			waiting: this.sql
				.exec<{ fork: string }>("SELECT fork FROM watch WHERE fork NOT IN (SELECT fork FROM pushed)")
				.toArray()
				.map((r) => r.fork),
			placing: this.sql.exec<{ fork: string }>("SELECT fork FROM pushed").toArray().map((r) => r.fork),
			// Running first, then the most recent finished runs.
			agents: this.sql
				.exec<AgentRun>("SELECT * FROM agent_run ORDER BY status = 'running' DESC, started DESC LIMIT 50")
				.toArray(),
			// `ready`: open and its deps have landed together, so it starts (agent) or can be taken (notagent).
			tasks: this.tasks().map(({ base_head, ...t }) => ({ ...t, ready: startable.has(t.id) })),
			memory: this.sql.exec("SELECT * FROM memory ORDER BY created").toArray(),
		};
	}

	// Agent runs on forks of this repo; kept after they finish so failures stay visible.
	agentStarted(fork: string, prompt: string) {
		this.sql.exec("INSERT INTO agent_run (fork, prompt, started) VALUES (?, ?, ?)", fork, prompt, Date.now());
	}

	agentDone(fork: string, status: string, log: string) {
		this.sql.exec("UPDATE agent_run SET status = ?, finished = ?, log = ? WHERE fork = ?", status, Date.now(), log, fork);
		if (status === "failed" || status === "lost") {
			this.sql.exec("UPDATE task SET status = 'failed', finished = ? WHERE fork = ? AND status = 'in-progress'", Date.now(), fork);
			this.sql.exec("DELETE FROM basis WHERE fork = ?", fork);
		}
	}

	// Repo holding `fork`'s version of its files: its own, or its bubble's rep once its series is queued
	// or applied (its repo is deleted by then).
	readFrom(fork: string): string | null {
		const f = this.sql.exec<Fork>("SELECT bubble, status FROM fork WHERE name = ?", fork).toArray()[0];
		return f ? (f.status === "merged" || f.status === "pending" || f.status === "failed" ? f.bubble : fork) : null;
	}

	diff(fork: string): string | null {
		return this.sql.exec<{ diff: string | null }>("SELECT diff FROM fork WHERE name = ?", fork).toArray()[0]?.diff ?? null;
	}

	// Deletes the git repos this repository still owns (base, reps, conflicting, watched and pre-patch-
	// series forks; placed forks are already gone), stops the bubbles' Boxes, then deletes every record.
	// Already-missing repos are skipped.
	async destroy(repo: string): Promise<string[]> {
		const bubbles = this.sql.exec<{ id: string }>("SELECT id FROM bubble").toArray().map((r) => r.id);
		const names = new Set([
			repo,
			...this.sql.exec<{ name: string }>("SELECT name FROM fork WHERE status IN ('rep', 'conflict') OR (status = 'pending' AND diff IS NULL)").toArray().map((r) => r.name),
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
		await Promise.all(bubbles.map((id) => this.bubbleBox(id).stop()));
		await this.ctx.storage.deleteAlarm();
		this.sql.exec(
			"DELETE FROM bubble; DELETE FROM fork; DELETE FROM conflict; DELETE FROM locked; DELETE FROM hidden; DELETE FROM watch; DELETE FROM pushed; DELETE FROM agent_run; DELETE FROM task; DELETE FROM task_dep; DELETE FROM memory; DELETE FROM owed; DELETE FROM basis; DELETE FROM renamed; DELETE FROM merging;",
		);
		this.ctx.storage.kv.delete("repo");
		this.ctx.storage.kv.delete("seq");
		return deleted;
	}

	// ---- the bubbles' queues and merges ----

	// Placement, applying queues and neighbour merges run together: placement never picks a hidden
	// bubble, a queue only grows by placement, and a neighbour merge only takes bubbles with empty
	// queues and hides them before its first await.
	async alarm(): Promise<void> {
		this.recoverHidden();
		const [placing, applying, merging] = await Promise.allSettled([this.pollWatches(), this.applyQueues(), this.mergeStep()]);
		await this.schedule(); // tasks whose deps just landed together in one bubble
		const worked = [applying, merging].some((r) => r.status === "fulfilled" && r.value) || this.busy().size > 0;
		const watching = this.sql.exec("SELECT 1 FROM watch").toArray().length > 0;
		if (worked) await this.ctx.storage.setAlarm(Date.now() + 1_000);
		else if (watching) await this.ctx.storage.setAlarm(Date.now() + POLL_MS);
		for (const r of [placing, applying, merging]) if (r.status === "rejected") throw r.reason;
	}

	private async kick() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	// ponytail: polling, because a per-fork Artifacts event subscription is more setup than a 5s poll.
	// Pushes landing inside one poll window all count as "the" push.
	private async pollWatches() {
		const already = new Set(this.sql.exec<{ fork: string }>("SELECT fork FROM pushed").toArray().map((r) => r.fork));
		await Promise.all(
			this.sql.exec<Watch>("SELECT * FROM watch").toArray().filter((w) => !already.has(w.fork)).map(async (w) => {
				using repo = await this.env.ARTIFACTS.get(w.fork);
				const head = (await repo.log({ limit: 1 }))[0]?.hash ?? "";
				if (head !== w.base) {
					await repo.revokeToken(w.token); // "shuts down the git server"
					this.sql.exec("INSERT OR IGNORE INTO pushed (fork) VALUES (?)", w.fork);
				} else if (Date.now() > w.expires) {
					this.sql.exec("DELETE FROM watch WHERE fork = ?", w.fork);
					this.sql.exec("DELETE FROM basis WHERE fork = ?", w.fork);
					// Nothing was pushed, so no work is lost: the task can be taken again.
					this.sql.exec("UPDATE task SET status = 'open', fork = NULL, base_head = NULL WHERE fork = ? AND status = 'in-progress'", w.fork);
					await this.env.ARTIFACTS.delete(w.fork);
				}
			}),
		);
		// Place every pushed fork at once: the repo's git Box turns each into its patch series, and
		// place() queues it. A fork's watch is kept until that succeeds, so the alarm retries failures.
		const forks = this.sql.exec<{ fork: string; base: string }>("SELECT p.fork, w.base FROM pushed p JOIN watch w ON w.fork = p.fork").toArray();
		const results = await Promise.allSettled(
			forks.map(async ({ fork, base }) => {
				const { url } = await authRemote(this.env, fork, "read");
				const p = await this.box().sh(PATCH_SH, [url, base]);
				let placed: Awaited<ReturnType<RepoDO["place"]>>;
				if (p.exitCode === MERGES) placed = { error: "its history has merge commits; rebase it onto where it started" };
				else if (p.exitCode !== 0) throw new Error(`patch series of ${fork} (${p.exitCode}): ${p.stderr}`);
				else placed = await this.place(fork, readSeries(p.stdout).files, readSeries(p.stdout).mbox);
				if ("error" in placed) {
					this.sql.exec("UPDATE task SET status = 'failed', explanation = ?, finished = ? WHERE fork = ? AND status = 'in-progress'", `Not placed: ${placed.error}`, Date.now(), fork);
					this.sql.exec("DELETE FROM basis WHERE fork = ?", fork);
					await this.env.ARTIFACTS.delete(fork).catch(() => false);
				}
				this.sql.exec("DELETE FROM watch WHERE fork = ?", fork);
				this.sql.exec("DELETE FROM pushed WHERE fork = ?", fork);
			}),
		);
		const failed = results.find((r) => r.status === "rejected");
		if (failed) throw (failed as PromiseRejectedResult).reason;
	}

	// Bubbles with queued series (or pre-patch-series forks still to merge).
	private busy() {
		return new Set(this.sql.exec<{ bubble: string }>("SELECT DISTINCT bubble FROM fork WHERE status = 'pending'").toArray().map((r) => r.bubble));
	}

	// Each visible bubble's Box applies its queued series, in queue order, all bubbles in parallel.
	// Returns whether anything was applied. A series that doesn't apply is marked failed (placement
	// should make that impossible). Forks from before patch series are merged in as before.
	private async applyQueues(): Promise<boolean> {
		const queued = this.sql
			.exec<{ name: string; bubble: string; diff: string | null; kind: string | null }>(
				"SELECT f.name, f.bubble, f.diff, t.kind FROM fork f JOIN bubble b ON b.id = f.bubble LEFT JOIN task t ON t.fork = f.name WHERE f.status = 'pending' AND b.visible = 1 ORDER BY f.rowid",
			)
			.toArray();
		const byBubble = Map.groupBy(queued, (f) => f.bubble);
		const domain = this.env.DOMAIN;
		const done = await Promise.allSettled(
			[...byBubble].map(async ([bubble, forks]) => {
				const box = this.bubbleBox(bubble);
				const { url } = await authRemote(this.env, bubble, "write");
				for (const f of forks.filter((f) => f.diff === null)) {
					const src = await authRemote(this.env, f.name, "read");
					const r = await box.mergeFrom(url, src.url, "merge fork");
					this.sql.exec("UPDATE fork SET status = ?, diff = ?, seq = ? WHERE name = ?", r.ok ? "merged" : "conflict", r.diff, r.ok ? this.nextSeq() : null, f.name);
					if (r.ok) await this.env.ARTIFACTS.delete(f.name).catch(() => false);
				}
				const series = forks.filter((f) => f.diff !== null);
				if (!series.length) return;
				const ok = await box.apply(
					url,
					series.map((f) => ({ fork: f.name, mbox: f.diff!, committer: { name: f.name, email: `${f.kind === "notagent" ? "notagent" : "agent"}@${domain}` } })),
				);
				series.forEach((f, i) => {
					if (!ok[i]) console.error(`series of ${f.name} did not apply to ${bubble}`);
					this.sql.exec("UPDATE fork SET status = ?, seq = ? WHERE name = ?", ok[i] ? "merged" : "failed", ok[i] ? this.nextSeq() : null, f.name);
				});
			}),
		);
		const failed = done.find((r) => r.status === "rejected");
		if (failed) throw (failed as PromiseRejectedResult).reason;
		return queued.length > 0;
	}

	// One neighbour merge: a visible bubble with an empty queue and its nearest such neighbour (distance
	// 0 first). Both are hidden; the neighbour's rep is merged into this rep by this bubble's Box. On
	// success the sets join; on conflict the pair is recorded. Returns whether a merge was attempted.
	private async mergeStep(): Promise<boolean> {
		const busy = this.busy();
		const free = this.bubbles().filter((h) => !busy.has(h.id));
		const conflicts = new Set(this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k));
		for (const h of free.filter((h) => h.visible)) {
			const nb = nearestNeighbour(h.id, free, conflicts);
			if (!nb) continue;
			this.hide(h.id, nb); // both invisible to placement while the merge runs
			try {
				const [rep, src] = await Promise.all([authRemote(this.env, h.id, "write"), authRemote(this.env, nb, "read")]);
				const r = await this.bubbleBox(h.id).mergeFrom(rep.url, src.url, "merge bubble");
				if (r.ok) {
					this.absorb(h.id, nb);
					this.sql.exec("UPDATE fork SET status = 'merged', diff = ?, seq = ? WHERE name = ?", r.diff, this.nextSeq(), nb);
					await this.env.ARTIFACTS.delete(nb);
					await this.bubbleBox(nb).stop();
				} else {
					this.sql.exec("INSERT OR IGNORE INTO conflict (k) VALUES (?)", conflictKey(h.id, nb));
				}
			} finally {
				this.show(h.id, nb);
			}
			return true;
		}
		return false;
	}

	// `from`'s code is now in `into`'s rep: its members (and its rep) move over, its conflicts and ferge
	// debts follow, and forks based on it resolve to `into`. `into`'s code changed other than by a
	// member's series, so its epoch moves on (forks based on its old code can't use the home rule).
	private absorb(into: string, from: string) {
		this.sql.exec("UPDATE fork SET bubble = ? WHERE bubble = ?", into, from);
		this.sql.exec("DELETE FROM bubble WHERE id = ?", from);
		this.sql.exec("UPDATE bubble SET epoch = epoch + 1 WHERE id = ?", into);
		this.sql.exec('UPDATE renamed SET "into" = ? WHERE "into" = ?', into, from);
		this.sql.exec('INSERT OR REPLACE INTO renamed ("from", "into") VALUES (?, ?)', from, into);
		// Its conflicts carry over, so they stay ferge-able and aren't rediscovered by a wasted merge.
		const keys = this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k);
		this.sql.exec("DELETE FROM conflict");
		for (const k of renameConflicts(keys, from, into)) this.sql.exec("INSERT INTO conflict (k) VALUES (?)", k);
		const owed = renameOwed(this.sql.exec<Owed>('SELECT locked, "into" FROM owed').toArray(), from, into);
		this.sql.exec("DELETE FROM owed");
		for (const o of owed) this.sql.exec('INSERT INTO owed (locked, "into") VALUES (?, ?)', o.locked, o.into);
	}

	private bubbles(): Bubble[] {
		const tables = new Map<string, { files: string[]; seq: number | null }[]>();
		for (const f of this.sql.exec<{ bubble: string; files: string; status: string; seq: number | null }>("SELECT bubble, files, status, seq FROM fork").toArray()) {
			const t = tables.get(f.bubble) ?? [];
			t.push({ files: JSON.parse(f.files), seq: f.status === "pending" ? null : (f.seq ?? 0) });
			tables.set(f.bubble, t);
		}
		return this.sql
			.exec<{ id: string; visible: number; locked: number; epoch: number; ferge: number }>(
				"SELECT id, visible, id IN (SELECT id FROM locked) AS locked, epoch, ferge FROM bubble ORDER BY seq",
			)
			.toArray()
			.map((h) => {
				const t = tables.get(h.id) ?? [];
				return { id: h.id, visible: !!h.visible, locked: !!h.locked, epoch: h.epoch, ferge: !!h.ferge, tables: t, files: new Set(t.flatMap((x) => x.files)) };
			});
	}

	// The Box holding bubble `id`'s rep clone: the only writer of that rep.
	private bubbleBox(id: string) {
		return this.env.BOX.getByName(`bubble-${id}`);
	}

	// This repository's git Box: turns pushed notagent forks into patch series.
	private box() {
		return this.env.BOX.getByName(`git-${this.ctx.id}`);
	}
}
