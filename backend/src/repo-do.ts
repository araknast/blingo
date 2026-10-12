import { DurableObject } from "cloudflare:workers";
import { authRemote, forkRepo, headOf } from "./box";
import { getAgentByName } from "agents";
import { COMMIT_FILES_SH, MERGES, PATCH_SH, UNBASED, readSeries } from "./git-scripts";
import { splitParts } from "./git";
import { conflictKey, fergeCandidate, nearestNeighbour, placeFork, renameConflicts, type Basis, type Bubble } from "./bubbles";
import { fergeName, friendlyName, nameText, type Name } from "./names";
import { NO_KEY, deployHeaders, deployKey, deployValues, gate, readSettings, updateWithKeys, type Provider, type Role, type Settings } from "./settings";
import { resolveSkills, type Skill } from "./skills";
import { explanation, fixPrompt, ready, renameOwed, shortTitle, type Owed, type PlanItem, type TaskState } from "./tasks";

const POLL_MS = 5_000;
const NO_LONGER_CONFLICT = "those bubbles no longer conflict";
// A merge or ferge hides its bubbles for seconds. Longer than the alarm's own wall-clock limit means
// the operation died (cancelled alarm, reset, deploy) without un-hiding them.
const HIDE_LEASE_MS = 15 * 60_000;
// A fork's patch series is kept in SQLite in parts (rows are at most 2 MB): `fork.diff` holds the first
// part and `fork_part` the rest. It crosses DO RPC whole (32 MiB a message), hence the cap.
// ponytail: store series in R2 if forks get bigger than this.
const MAX_SERIES = 25_000_000;
const PLACE_TRIES = 5; // placement attempts that may fail with an error before a fork goes loose
const PART = 500_000; // UTF-16 units: at most 1.5 MB of UTF-8
// SQL: ferge bubble `b` has a ferge agent at work on its conflicts (yorkle's attention.ts fergeAgent):
// not yet done, or done with its fix still queued there (the bubble unlocks once that's applied).
const FERGE_AGENT = `EXISTS (SELECT 1 FROM task t WHERE t.role = 'ferge' AND t.bubble = b.id AND (t.status IN ('open', 'in-progress', 'awaiting-approval')
	OR (t.status = 'completed' AND EXISTS (SELECT 1 FROM fork f WHERE f.name = t.fork AND f.bubble = b.id AND f.status = 'pending'))))`;

// status: rep = the fork that started the bubble; pending = its patch series is queued; merged = applied
// (or merged in, for forks from before patch series); failed = its series didn't apply; conflict = a
// pre-patch-series fork that didn't merge. `seq` orders applied series (see Basis).
type Fork = { name: string; bubble: string; status: "rep" | "pending" | "merged" | "conflict" | "failed"; files: string; seq: number | null };
// A fork pushed to (or waiting for its first push) and not placed yet: a notagent's, or, with CI on,
// an agent's. `base`: the commit it started from; `head`: its head when last seen; `token`: the id of
// its live push token (NULL once revoked or expired); `placing`: its placement is running; `reason`:
// why it isn't placed. (Rows may have an unused `sub` column, from push-event subscriptions.) CI results are for `head`:
// `ci` running / passed / failed with its log tail, each review pending / approved / rejected (NULL =
// not required) and their comments in `review_note`; `agent_pushes` counts an agent's attempts.
type Loose = {
	fork: string;
	base: string;
	head: string;
	token: string | null;
	expires: number;
	pushes: number;
	placing: number;
	reason: string | null;
	kind: "agent" | "notagent";
	ci: string | null;
	ci_log: string | null;
	review_auto: string | null;
	review_manual: string | null;
	review_note: string | null;
	agent_pushes: number;
};
const ciState = (l: Loose) => ({ ci: l.ci, reviewAuto: l.review_auto, reviewManual: l.review_manual });
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
	role: Role | null; // which model its agent uses (NULL = agent)
	model: string | null; // a model chosen for this task alone, over the role's
	skills: string | null; // JSON list of skill names its agent loads; NULL = all of the repository's
	prev_fork: string | null; // retried: the failed attempt's run, whose context the next agent gets
};
// A task to add: a superagent's plan item (deps by key within the batch), or one from the API.
export type NewTask = Omit<PlanItem, "key"> & { key?: string; bubble?: string | null; role?: Role; model?: string };

// One per blingo repository: placement, the bubbles' patch queues and bubble merges. Each bubble's rep
// is written only by that bubble's own Box (see Box.rep), which applies its queue and runs its merges.
// ponytail: one neighbour merge at a time per repo (alarm is single-flight); disjoint pairs could run in parallel.
export class RepoDO extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;
	// Placement attempts in a row that failed with an error (checkLoose). ponytail: in memory, so a
	// restart gives a fork another PLACE_TRIES.
	private placeFails = new Map<string, number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Bubble id == name of its representative fork.
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS bubble(id TEXT PRIMARY KEY, visible INTEGER NOT NULL DEFAULT 1, seq INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS fork(name TEXT PRIMARY KEY, bubble TEXT NOT NULL, status TEXT NOT NULL, files TEXT NOT NULL, diff TEXT);
			CREATE TABLE IF NOT EXISTS fork_part(fork TEXT NOT NULL, i INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (fork, i)); -- a long diff's later parts
			CREATE TABLE IF NOT EXISTS conflict(k TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS locked(id TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS hidden(id TEXT PRIMARY KEY, since INTEGER NOT NULL); -- lease for bubble.visible = 0
			-- watch/pushed: before loose forks; emptied into loose below
			CREATE TABLE IF NOT EXISTS watch(fork TEXT PRIMARY KEY, base TEXT NOT NULL, token TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS pushed(fork TEXT PRIMARY KEY);
			CREATE TABLE IF NOT EXISTS loose(fork TEXT PRIMARY KEY, base TEXT NOT NULL, head TEXT NOT NULL, token TEXT, expires INTEGER NOT NULL,
				pushes INTEGER NOT NULL DEFAULT 0, placing INTEGER NOT NULL DEFAULT 0, sub TEXT, reason TEXT);
			CREATE TABLE IF NOT EXISTS agent_run(fork TEXT PRIMARY KEY, prompt TEXT NOT NULL, started INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'running', finished INTEGER, log TEXT);
			-- bubble: where an open task without deps starts (NULL = any); once started, where it did.
			CREATE TABLE IF NOT EXISTS task(id TEXT PRIMARY KEY, description TEXT NOT NULL, kind TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'open', bubble TEXT, fork TEXT, base_head TEXT, explanation TEXT,
				superagent TEXT, created INTEGER NOT NULL, finished INTEGER, title TEXT NOT NULL DEFAULT '');
			CREATE TABLE IF NOT EXISTS task_dep(task TEXT NOT NULL, dep TEXT NOT NULL, PRIMARY KEY (task, dep));
			-- a repository's skills (Claude Code skill folders); files are base64, one row each
			CREATE TABLE IF NOT EXISTS skill(name TEXT PRIMARY KEY, description TEXT NOT NULL, created INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS skill_file(skill TEXT NOT NULL, path TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (skill, path));
			-- manual deployments: a command run on a bubble's commit (status running / succeeded / failed)
			CREATE TABLE IF NOT EXISTS deploy(id TEXT PRIMARY KEY, name TEXT NOT NULL, bubble TEXT NOT NULL, head TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
				started INTEGER NOT NULL, finished INTEGER, log TEXT, by TEXT NOT NULL);
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
		// Bubble names (names.ts): the first bubble is called after the repository, ferge bubbles after
		// the two they came from, the rest get a friendly "adjective noun". Older bubbles get one now.
		for (const c of ["name", "adj", "noun"]) this.addColumn("bubble", c, "TEXT NOT NULL DEFAULT ''");
		for (const r of this.sql.exec<{ id: string }>("SELECT id FROM bubble WHERE noun = ''").toArray()) {
			const n = friendlyName();
			this.sql.exec("UPDATE bubble SET name = ?, adj = ?, noun = ? WHERE id = ?", nameText(n), n.adj, n.noun, r.id);
			this.ctx.storage.kv.put("namedFirst", true);
		}
		this.addColumn("task", "role", "TEXT");
		this.addColumn("task", "model", "TEXT");
		this.addColumn("task", "skills", "TEXT"); // JSON list of the skills its agent loads (NULL = all)
		this.addColumn("task", "prev_fork", "TEXT"); // a retried task's failed attempt (its Box keeps the run)
		for (const [c, d] of [["kind", "TEXT NOT NULL DEFAULT 'notagent'"], ["ci", "TEXT"], ["ci_log", "TEXT"], ["review_auto", "TEXT"], ["review_manual", "TEXT"], ["review_note", "TEXT"], ["agent_pushes", "INTEGER NOT NULL DEFAULT 0"]]) {
			this.addColumn("loose", c, d);
		}
		// Watched notagent forks from before loose forks: pushed ones go on to placement.
		this.sql.exec(`INSERT OR IGNORE INTO loose (fork, base, head, token, expires, pushes, placing)
			SELECT w.fork, w.base, w.base, w.token, w.expires, p.fork IS NOT NULL, p.fork IS NOT NULL FROM watch w LEFT JOIN pushed p ON p.fork = w.fork;
			DELETE FROM watch; DELETE FROM pushed;`);
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

	// The repository's display name (UsersDO keeps it too); its first bubble is called after it.
	setName(name: string) {
		this.ctx.storage.kv.put("name", name);
	}

	private newBubbleName(): Name {
		if (this.ctx.storage.kv.get("namedFirst")) return friendlyName();
		this.ctx.storage.kv.put("namedFirst", true);
		const repo = this.ctx.storage.kv.get<string>("name");
		return repo ? { adj: "", noun: repo } : friendlyName();
	}

	// A finished fork's patch series (its changed `files` and `git format-patch` `mbox`) joins the queue of
	// the first bubble it applies to cleanly (placeFork), or starts a new bubble with the fork as its rep.
	// Nothing awaits between choosing the bubble and queueing, so concurrent placements can't collide; a
	// bubble with queued series is never merged away (mergeStep), so the series always reaches its rep.
	// The fork's task completes, explained by the series' commit messages. A fork that changed nothing
	// joins no bubble.
	async place(fork: string, files: string[], mbox: string): Promise<{ bubble: string | null } | { error: string }> {
		if (mbox.length > MAX_SERIES) return { error: `its patch series is over ${MAX_SERIES} bytes` };
		// With CI on, a fork reaches a bubble only through its loose row, once it has passed.
		const settings = this.settings();
		const l = this.loose(fork);
		if (settings.ci.enabled && (!l || gate(settings, ciState(l)) !== "passed")) return { error: "it hasn't passed CI" };
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
			const n = this.newBubbleName();
			this.sql.exec(
				"INSERT INTO bubble (id, visible, seq, name, adj, noun) VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble), ?, ?, ?)",
				fork,
				nameText(n),
				n.adj,
				n.noun,
			);
			this.sql.exec(
				"INSERT INTO fork (name, bubble, status, files, diff, seq) VALUES (?, ?, 'rep', ?, ?, ?)",
				fork,
				fork,
				JSON.stringify([...new Set([...files, ...basisFiles])]),
				"",
				this.nextSeq(),
			);
			this.putDiff(fork, mbox);
		} else if (target) {
			this.sql.exec("INSERT INTO fork (name, bubble, status, files, diff) VALUES (?, ?, 'pending', ?, '')", fork, target, JSON.stringify(files));
			this.putDiff(fork, mbox);
		}
		this.sql.exec(
			"UPDATE task SET status = 'completed', explanation = ?, finished = ? WHERE fork = ? AND status = 'in-progress'",
			explanation(mbox),
			Date.now(),
			fork,
		);
		// Placed: no longer loose, in the same step its task completes (no window where it is both).
		this.sql.exec("DELETE FROM loose WHERE fork = ?", fork);
		// The series carries the fork's code now. Its repo stays as a new bubble's rep, or until the series
		// is applied, for its env to merge into the bubble's (applyQueues).
		if (target === null) await this.env.ARTIFACTS.delete(fork).catch(() => false);
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
		const available = this.skillNames();
		for (const i of items) {
			const r = resolveSkills(i.skills, available);
			if ("error" in r) return r;
		}
		this.ctx.storage.kv.put("repo", repo);
		const status = this.settings().taskApproval ? "awaiting-approval" : "open";
		items.forEach((i, n) => {
			const id = ids.get(i.key ?? String(n))!;
			this.sql.exec(
				"INSERT INTO task (id, title, description, kind, status, bubble, superagent, created, role, model, skills) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				i.title,
				i.description,
				i.kind,
				status,
				i.bubble ?? null,
				superagent,
				Date.now(),
				i.role ?? null,
				i.model || null,
				i.skills === undefined ? null : JSON.stringify(i.skills),
			);
			for (const d of i.deps) this.sql.exec("INSERT OR IGNORE INTO task_dep (task, dep) VALUES (?, ?)", id, dep(d));
		});
		await this.schedule();
		return { ids: [...ids.values()] };
	}

	task(id: string) {
		return this.sql.exec<Omit<TaskRow, "deps">>("SELECT * FROM task WHERE id = ?", id).toArray()[0] ?? null;
	}

	// With task approval on: a task awaiting approval can be edited, then approved to start.
	editTask(id: string, title: string | undefined, description: string | undefined): { ok: true } | { error: string } {
		if (this.task(id)?.status !== "awaiting-approval") return { error: "only a task awaiting approval can be edited" };
		if (title !== undefined) this.sql.exec("UPDATE task SET title = ? WHERE id = ?", title, id);
		if (description !== undefined) this.sql.exec("UPDATE task SET description = ? WHERE id = ?", description, id);
		return { ok: true };
	}

	async approveTask(id: string): Promise<boolean> {
		const n = this.sql.exec("UPDATE task SET status = 'open' WHERE id = ? AND status = 'awaiting-approval'", id).rowsWritten;
		if (n) await this.schedule();
		return n > 0;
	}

	// Turns down a task awaiting approval: it's deleted. Not while another task depends on it, which
	// would then wait forever; reject those first.
	rejectTask(id: string): { ok: true } | { error: string } {
		if (this.task(id)?.status !== "awaiting-approval") return { error: "only a task awaiting approval can be rejected" };
		const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM task_dep WHERE dep = ?", id).one().n;
		if (n) return { error: `${n === 1 ? "a task depends" : `${n} tasks depend`} on it: reject ${n === 1 ? "that one" : "those"} first` };
		this.sql.exec("DELETE FROM task_dep WHERE task = ?", id);
		this.sql.exec("DELETE FROM task WHERE id = ?", id);
		return { ok: true };
	}

	// Undoes a task added for a request that then failed (its notagent fork couldn't be made), so a
	// retried request doesn't leave an orphan open task behind. Only while nothing has started it.
	dropTask(id: string) {
		this.sql.exec("DELETE FROM task WHERE id = ? AND status = 'open' AND fork IS NULL AND NOT EXISTS (SELECT 1 FROM task_dep WHERE dep = ?)", id, id);
	}

	// `previous`: the run whose context the next agent gets, if not the task's last one (any agent run
	// of this repository).
	async retryTask(id: string, previous?: string): Promise<{ error: string } | { ok: true }> {
		if (previous && !this.sql.exec("SELECT 1 FROM agent_run WHERE fork = ?", previous).toArray().length) return { error: "no such agent run in this repository" };
		const n = this.sql.exec("UPDATE task SET status = 'open', prev_fork = COALESCE(?, fork), fork = NULL, finished = NULL WHERE id = ? AND status = 'failed'", previous ?? null, id).rowsWritten;
		if (!n) return { error: "that task hasn't failed" };
		await this.schedule();
		return { ok: true };
	}

	// Stops an agent task's running agent: its run fails (transcript kept), and so does the task.
	async stopTask(id: string): Promise<{ error: string } | { ok: true }> {
		const t = this.task(id);
		if (t?.kind !== "agent" || t.status !== "in-progress" || !t.fork) return { error: "that task has no running agent" };
		return (await this.env.BOX.getByName(t.fork).stopAgent()) ? { ok: true } : { error: "its agent isn't running" };
	}

	// A human takes an open notagent task: it gets a loose fork with a 1-hour push token. The task is
	// back to open if nothing is pushed in time.
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
			this.sql.exec("INSERT INTO loose (fork, base, head, token, expires) VALUES (?, ?, ?, ?, ?)", fork, base, base, token.id, Date.parse(token.expiresAt));
			await this.kick();
			return { repo, task: id, fork, remote, token: token.plaintext, clone: `git clone --single-branch ${authed} ${fork}`, push: `git push ${authed} HEAD:main` };
		} catch (e) {
			this.sql.exec("UPDATE task SET status = 'open', fork = NULL WHERE id = ? AND status = 'in-progress'", id);
			throw e;
		}
	}

	// ---- skills ----

	skillNames(): string[] {
		return this.sql.exec<{ name: string }>("SELECT name FROM skill ORDER BY name").toArray().map((r) => r.name);
	}

	// Adds (or replaces) a parsed skill upload.
	addSkill(skill: Skill) {
		this.sql.exec("DELETE FROM skill_file WHERE skill = ?", skill.name);
		this.sql.exec("INSERT OR REPLACE INTO skill (name, description, created) VALUES (?, ?, ?)", skill.name, skill.description, Date.now());
		for (const f of skill.files) this.sql.exec("INSERT INTO skill_file (skill, path, data) VALUES (?, ?, ?)", skill.name, f.path, f.data);
	}

	// Removing a skill also takes it out of the tasks that named it.
	deleteSkill(name: string): boolean {
		for (const t of this.sql.exec<{ id: string; skills: string }>("SELECT id, skills FROM task WHERE skills IS NOT NULL").toArray()) {
			const rest = (JSON.parse(t.skills) as string[]).filter((n) => n !== name);
			this.sql.exec("UPDATE task SET skills = ? WHERE id = ?", JSON.stringify(rest), t.id);
		}
		this.sql.exec("DELETE FROM skill_file WHERE skill = ?", name);
		return this.sql.exec("DELETE FROM skill WHERE name = ?", name).rowsWritten > 0;
	}

	// The skills an agent loads: those a task names (a JSON list; NULL = all), with their files.
	// A superagent gets every skill, as a list only (it assigns them to tasks).
	// One skill's files, to read in the UI: SKILL.md's text, and every file's path and size.
	skillFiles(name: string): { name: string; description: string; skillMd: string; files: { path: string; bytes: number }[] } | null {
		const s = this.sql.exec<{ name: string; description: string }>("SELECT name, description FROM skill WHERE name = ?", name).toArray()[0];
		if (!s) return null;
		const rows = this.sql.exec<{ path: string; data: string }>("SELECT path, data FROM skill_file WHERE skill = ? ORDER BY path", name).toArray();
		const md = rows.find((r) => r.path === "SKILL.md");
		const skillMd = md ? new TextDecoder().decode(Uint8Array.from(atob(md.data), (c) => c.charCodeAt(0))) : "";
		return { ...s, skillMd, files: rows.map((r) => ({ path: r.path, bytes: Math.floor((r.data.length * 3) / 4) - (r.data.endsWith("==") ? 2 : r.data.endsWith("=") ? 1 : 0) })) };
	}

	skillPack(named: string | null): Skill[] {
		const names = named === null ? this.skillNames() : (JSON.parse(named) as string[]);
		return this.sql
			.exec<{ name: string; description: string }>("SELECT name, description FROM skill ORDER BY name")
			.toArray()
			.filter((s) => names.includes(s.name))
			.map((s) => ({ ...s, files: this.sql.exec<{ path: string; data: string }>("SELECT path, data FROM skill_file WHERE skill = ?", s.name).toArray() }));
	}

	// New memory items also reach agents already running, through their memory hook (Box.pushMemory).
	async addMemory(texts: string[], author: string) {
		for (const text of texts) {
			this.sql.exec("INSERT INTO memory (id, text, author, created) VALUES (?, ?, ?, ?)", `m-${crypto.randomUUID().slice(0, 8)}`, text, author, Date.now());
		}
		const memory = this.memories();
		const running = this.sql.exec<{ fork: string }>("SELECT fork FROM agent_run WHERE status = 'running'").toArray();
		await Promise.allSettled(running.map((r) => this.env.BOX.getByName(r.fork).pushMemory(memory)));
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
	// don't start one twice; a start that fails goes back to open for the next call. Without an API
	// key nothing starts: tasks wait until one is set (setSettings kicks).
	private async schedule() {
		const repo = this.ctx.storage.kv.get<string>("repo");
		if (!repo || !this.credentials()) return;
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
					await this.env.BOX.getByName(fork).startAgent({ repo, fork, remote, prompt, kind: "agent", memory, skills: this.skillPack(t.skills), previous: t.prev_fork ?? undefined, ...this.agentConfig(t.role ?? "agent", t.model) });
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
				await rep.fork(l, { defaultBranchOnly: false });
			}
			const [ra, rb, rl] = await Promise.all([
				authRemote(this.env, a, "write"),
				authRemote(this.env, b, "read"),
				authRemote(this.env, l, "write"),
			]);
			const r = await this.bubbleBox(a).ferge(ra.url, rb.url, rl.url);
			if (!r) return { error: NO_LONGER_CONFLICT };
			// b's env joins a's, and l's (forked from a before).
			await this.bubbleBox(a).mergeEnv(ra.url, [rb.url]);
			await this.bubbleBox(a).mergeEnv(rl.url, [rb.url]);
			const names = this.sql.exec<Name & { id: string }>("SELECT id, adj, noun FROM bubble WHERE id IN (?, ?)", a, b).toArray();
			const name = fergeName(names.find((n) => n.id === a)!, names.find((n) => n.id === b)!); // before b is absorbed
			this.absorb(a, b);
			this.sql.exec("UPDATE fork SET status = 'merged', seq = ? WHERE name = ?", this.nextSeq(), b);
			this.sql.exec("DELETE FROM conflict WHERE k = ?", conflictKey(a, b));
			this.sql.exec(
				"INSERT INTO bubble (id, visible, seq, ferge, name, adj, noun) VALUES (?, 1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM bubble), 1, ?, '', ?)",
				l,
				name,
				name,
			);
			this.sql.exec("INSERT INTO fork (name, bubble, status, files, seq) VALUES (?, ?, 'rep', ?, ?)", l, l, JSON.stringify(r.tree), this.nextSeq());
			this.sql.exec("INSERT INTO locked (id) VALUES (?)", l);
			this.sql.exec('INSERT OR IGNORE INTO owed (locked, "into") VALUES (?, ?)', l, a); // a lacks those files until l merges back
			done = true;
			await this.env.ARTIFACTS.delete(b);
			await this.bubbleBox(b).stop();
			if (this.settings().fergeAgents) {
				await this.addTasks(repo, [
					{
						title: shortTitle(`Resolve the conflicts in ${name}`),
						description: `This bubble holds files that two bubbles changed in ways git couldn't merge, with git conflict markers (<<<<<<<, =======, >>>>>>>) in them. Resolve every conflict: keep what both sides meant, remove every marker, make sure the result works, and commit.\n\nConflicting files:\n${r.files.map((f) => `- ${f}`).join("\n")}`,
						kind: "agent",
						deps: [],
						bubble: l,
						role: "ferge",
					},
				]);
			}
			return { bubble: a, locked: l, files: r.files };
		} finally {
			if (!done) await this.env.ARTIFACTS.delete(l).catch(() => false);
			this.show(a, b);
			await this.kick();
		}
	}

	// A person resolves a locked ferge bubble's conflicts in the UI: their files go in as a notagent task
	// on that bubble (its fork, a commit there, then placement, which takes a ferge fork home). Unlocking
	// is still theirs to do once it's placed. Not while a ferge agent is at work on them.
	async resolveFerge(bubble: string, files: Record<string, string>, author: string): Promise<{ task: string; fork: string; placing: boolean } | { error: string }> {
		const b = this.sql.exec<{ id: string; ferge: number; name: string; agent: number }>(`SELECT id, ferge, name, ${FERGE_AGENT} AS agent FROM bubble b WHERE id = ?`, bubble).toArray()[0];
		if (!b?.ferge) return { error: "that isn't a ferge bubble" };
		if (!this.sql.exec("SELECT 1 FROM locked WHERE id = ?", bubble).toArray().length) return { error: "that ferge bubble is already unlocked" };
		if (b.agent) return { error: "an agent is resolving that ferge bubble's conflicts" };
		const repo = this.ctx.storage.kv.get<string>("repo")!;
		const added = await this.addTasks(repo, [{ title: shortTitle(`Resolve the conflicts in ${b.name}`), description: `Resolved by ${author} in the conflict resolver:\n${Object.keys(files).map((f) => `- ${f}`).join("\n")}`, kind: "notagent", deps: [], bubble }]);
		if ("error" in added) return added;
		const [task] = added.ids;
		this.sql.exec("UPDATE task SET status = 'open' WHERE id = ? AND status = 'awaiting-approval'", task); // asked for by a person
		const taken = await this.takeTask(task);
		if (taken.error !== undefined) return { error: taken.error };
		const { url } = await authRemote(this.env, taken.fork, "write");
		const r = await this.box().sh(COMMIT_FILES_SH, [url, "Resolve ferge conflicts"], { stdin: JSON.stringify(files), env: { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: `${author}@users.blingo` } });
		if (r.exitCode !== 0) return { error: `couldn't commit the files: ${r.stderr.trim().split("\n").at(-1) ?? ""}` };
		await this.onPushed(taken.fork, await headOf(this.env, taken.fork));
		const placed = this.loose(taken.fork)?.placing ? true : !("error" in (await this.requestPlacement(taken.fork))); // else it waits for CI/review
		return { task, fork: taken.fork, placing: placed };
	}

	// Any bubble to fork when none is named (visible first, oldest first); null if the repo has none yet.
	anyBubble(): string | null {
		return this.sql.exec<{ id: string }>("SELECT id FROM bubble ORDER BY visible DESC, seq LIMIT 1").toArray()[0]?.id ?? null;
	}

	// Counts only, for the repository list (list() is far too big to fetch per repository there).
	summary() {
		const n = (q: string) => this.sql.exec<{ n: number }>(q).one().n;
		return {
			bubbles: n("SELECT COUNT(*) AS n FROM bubble"),
			forks: n("SELECT COUNT(*) AS n FROM fork WHERE bubble IN (SELECT id FROM bubble)"),
			working: n("SELECT COUNT(*) AS n FROM agent_run WHERE status = 'running'"),
			conflicts: n("SELECT COUNT(*) AS n FROM conflict"),
			needs: this.needsCount(),
		};
	}

	// How many things need a person, by the rules of the Overview's "Needs you" list (yorkle's
	// lib/attention.ts `needs`; keep the two in step), less new memory notes, which are per viewer. A
	// missing key isn't one (notagents still work); a key saved for another provider is.
	private needsCount() {
		const n = (q: string, ...p: unknown[]) => this.sql.exec<{ n: number }>(q, ...p).one().n;
		const s = this.settings();
		const loose = n(
			`SELECT COUNT(*) AS n FROM loose WHERE pushes > 0 AND placing = 0 AND (review_manual = 'pending' OR (kind = 'notagent' AND (reason IS NOT NULL
				OR ci = 'failed' OR review_auto = 'rejected' OR review_manual = 'rejected' OR (? AND COALESCE(ci, '') <> 'running' AND COALESCE(review_auto, '') <> 'pending'))))`,
			s.autoPlaceNotagents ? 0 : 1,
		);
		const key = this.ctx.storage.kv.get<string>("apiKey");
		const keyProvider = this.ctx.storage.kv.get<string>("keyProvider");
		const keyNeed = key && keyProvider && keyProvider !== s.provider ? 1 : 0;
		const deploys = n(
			"SELECT COUNT(*) AS n FROM deploy d WHERE status = 'failed' AND started = (SELECT MAX(started) FROM deploy WHERE name = d.name)",
		);
		return (
			n("SELECT COUNT(*) AS n FROM conflict") +
			loose +
			n("SELECT COUNT(*) AS n FROM task WHERE status IN ('failed', 'awaiting-approval')") +
			n("SELECT COUNT(*) AS n FROM fork WHERE status = 'failed' AND bubble IN (SELECT id FROM bubble)") +
			n(`SELECT COUNT(*) AS n FROM bubble b WHERE ferge = 1 AND id IN (SELECT id FROM locked) AND NOT ${FERGE_AGENT}`) +
			keyNeed +
			deploys
		);
	}

	list() {
		const forks = this.sql.exec<Fork>("SELECT name, bubble, status, files FROM fork").toArray();
		const startable = this.startable();
		const names = new Map(this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM bubble").toArray().map((r) => [r.id, r.name]));
		return {
			name: this.ctx.storage.kv.get<string>("name") ?? null,
			bubbles: this.bubbles().map((h) => ({
				id: h.id,
				name: names.get(h.id) ?? "",
				ferge: !!h.ferge,
				visible: h.visible,
				locked: !!h.locked,
				members: forks.filter((f) => f.bubble === h.id).map((f) => ({ ...f, files: JSON.parse(f.files) })),
			})),
			conflicts: this.sql.exec<{ k: string }>("SELECT k FROM conflict").toArray().map((r) => r.k.split("|")),
			merging: this.sql.exec<{ a: string; b: string }>("SELECT a, b FROM merging").toArray().map((r) => [r.a, r.b]),
			// Notagent forks waiting for their first push, pushed ones being placed, and pushed ones waiting
			// to be placed (`loose`: auto-placement is off, or their placement failed).
			waiting: this.sql.exec<{ fork: string }>("SELECT fork FROM loose WHERE pushes = 0").toArray().map((r) => r.fork),
			placing: this.sql.exec<{ fork: string }>("SELECT fork FROM loose WHERE placing = 1").toArray().map((r) => r.fork),
			loose: this.sql
				.exec<Loose>("SELECT * FROM loose WHERE pushes > 0 AND placing = 0")
				.toArray()
				.map((l) => ({
					fork: l.fork,
					kind: l.kind,
					pushes: l.pushes,
					pushable: l.token !== null,
					reason: l.reason,
					ci: l.ci,
					ciLog: l.ci_log,
					reviewAuto: l.review_auto,
					reviewManual: l.review_manual,
					reviewNote: l.review_note,
				})),
			settings: this.publicSettings(),
			// Running first, then the most recent finished runs.
			agents: this.sql
				.exec<AgentRun>("SELECT * FROM agent_run ORDER BY status = 'running' DESC, started DESC LIMIT 50")
				.toArray(),
			// `ready`: open and its deps have landed together, so it starts (agent) or can be taken (notagent).
			tasks: this.tasks().map(({ base_head, skills, ...t }) => ({ ...t, skills: skills === null ? null : JSON.parse(skills), ready: startable.has(t.id) })),
			memory: this.sql.exec("SELECT * FROM memory ORDER BY created").toArray(),
			skills: this.sql.exec("SELECT name, description, created FROM skill ORDER BY name").toArray(),
			deploys: this.sql.exec("SELECT * FROM deploy ORDER BY started DESC LIMIT 50").toArray(),
		};
	}

	// Agent runs on forks of this repo; kept after they finish so failures stay visible.
	agentStarted(fork: string, prompt: string) {
		this.sql.exec("INSERT INTO agent_run (fork, prompt, started) VALUES (?, ?, ?)", fork, prompt, Date.now());
	}

	// `fork` is the run's id: a fork, a superagent run (-s-), or a CI fixer on a fork (<fork>-c<n>).
	agentDone(fork: string, status: string, log: string) {
		this.sql.exec("UPDATE agent_run SET status = ?, finished = ?, log = ? WHERE fork = ?", status, Date.now(), log, fork);
		const fixed = fork.match(/^(.*-f-[^-]+)-c\d+$/)?.[1];
		if (fixed && (status === "failed" || status === "lost")) {
			const l = this.loose(fixed);
			if (l?.kind === "agent") this.toNotagent(fixed, `${l.reason ?? "CI failed"}; its fixer agent failed, so a person takes over`);
			return;
		}
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

	// A fork's whole diff (its patch series, or what merging it in changed); null for a fork from before
	// patch series that isn't merged yet.
	diff(fork: string): string | null {
		const first = this.sql.exec<{ diff: string | null }>("SELECT diff FROM fork WHERE name = ?", fork).toArray()[0]?.diff ?? null;
		if (first === null) return null;
		return first + this.sql.exec<{ text: string }>("SELECT text FROM fork_part WHERE fork = ? ORDER BY i", fork).toArray().map((r) => r.text).join("");
	}

	// Stores `text` as fork `fork`'s diff (its row must exist): the first part in the row, the rest in fork_part.
	private putDiff(fork: string, text: string) {
		const [first, ...rest] = splitParts(text, PART);
		this.sql.exec("UPDATE fork SET diff = ? WHERE name = ?", first, fork);
		this.sql.exec("DELETE FROM fork_part WHERE fork = ?", fork);
		rest.forEach((t, i) => this.sql.exec("INSERT INTO fork_part (fork, i, text) VALUES (?, ?, ?)", fork, i + 1, t));
	}

	// Deletes the git repos this repository still owns (base, reps, conflicting, loose and queued forks;
	// applied forks are already gone), stops the bubbles' and running agents' Boxes, then deletes every record.
	// Already-missing repos are skipped.
	async destroy(repo: string): Promise<string[]> {
		const bubbles = this.sql.exec<{ id: string }>("SELECT id FROM bubble").toArray().map((r) => r.id);
		const names = new Set([
			repo,
			...this.sql.exec<{ name: string }>("SELECT name FROM fork WHERE status IN ('rep', 'conflict', 'pending')").toArray().map((r) => r.name),
			...this.sql.exec<{ fork: string }>("SELECT fork FROM loose").toArray().map((r) => r.fork),
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
		// Running agents, superagents and CI fixers (Box named after the run), and loose forks' CI.
		const runs = this.sql.exec<{ fork: string }>("SELECT fork FROM agent_run WHERE status = 'running'").toArray().map((r) => r.fork);
		const ci = this.sql.exec<{ fork: string }>("SELECT fork FROM loose").toArray().map((r) => `ci-${r.fork}`);
		const deploying = this.sql.exec<{ id: string }>("SELECT id FROM deploy WHERE status = 'running'").toArray().map((r) => `deploy-${r.id}`);
		await Promise.allSettled([...runs, ...ci, ...deploying].map((n) => this.env.BOX.getByName(n).stop()));
		await this.ctx.storage.deleteAlarm();
		this.sql.exec(
			"DELETE FROM bubble; DELETE FROM fork; DELETE FROM fork_part; DELETE FROM conflict; DELETE FROM locked; DELETE FROM hidden; DELETE FROM loose; DELETE FROM agent_run; DELETE FROM task; DELETE FROM task_dep; DELETE FROM memory; DELETE FROM skill; DELETE FROM skill_file; DELETE FROM deploy; DELETE FROM owed; DELETE FROM basis; DELETE FROM renamed; DELETE FROM merging;",
		);
		for (const k of ["repo", "seq", "name", "namedFirst", "settings", "apiKey", "keyProvider", "reviewerKey", "deployAuth"]) this.ctx.storage.kv.delete(k);
		return deleted;
	}

	// ---- the bubbles' queues and merges ----

	// Placement, applying queues and neighbour merges run together: placement never picks a hidden
	// bubble, a queue only grows by placement, and a neighbour merge only takes bubbles with empty
	// queues and hides them before its first await.
	async alarm(): Promise<void> {
		this.recoverHidden();
		this.reapDeploys();
		const [placing, applying, merging] = await Promise.allSettled([this.checkLoose(), this.applyQueues(), this.mergeStep()]);
		await this.schedule(); // tasks whose deps just landed together in one bubble
		const worked = [applying, merging].some((r) => r.status === "fulfilled" && r.value) || this.busy().size > 0;
		const next = worked ? Date.now() + 1_000 : this.nextLooseCheck();
		if (next !== null) await this.ctx.storage.setAlarm(next);
		for (const r of [placing, applying, merging]) if (r.status === "rejected") throw r.reason;
	}

	private async kick() {
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	// ---- loose forks and CI ----

	settings(): Settings {
		return readSettings(this.ctx.storage.kv.get<Partial<Settings>>("settings") ?? {});
	}

	// The settings as the API shows them: the API key only as whether one is set.
	publicSettings() {
		const values = this.ctx.storage.kv.get<Record<string, string>>("deployAuth") ?? {};
		const s = this.settings();
		const deploys = s.deploys.map((d) => ({ ...d, auth: d.auth.map((a) => ({ ...a, hasValue: !!values[deployKey(d.name, a.host, a.header)] })) }));
		// `keyProvider`: the provider the key was saved for (null for keys saved before it was recorded).
		const hasKey = !!this.ctx.storage.kv.get<string>("apiKey");
		const keyProvider = hasKey ? (this.ctx.storage.kv.get<Settings["provider"]>("keyProvider") ?? null) : null;
		return { ...s, deploys, hasKey, keyProvider, hasReviewerKey: !!this.ctx.storage.kv.get<string>("reviewerKey") };
	}

	// `apiKey` (a string; "" removes it) is kept apart from the other settings and never returned.
	async setSettings(body: unknown) {
		const u = updateWithKeys(this.settings(), body, !!this.ctx.storage.kv.get<string>("reviewerKey"));
		if ("error" in u) return u;
		const { next, key, reviewerKey: rkey } = u;
		this.ctx.storage.kv.put("settings", next);
		if (typeof rkey === "string") rkey ? this.ctx.storage.kv.put("reviewerKey", rkey) : this.ctx.storage.kv.delete("reviewerKey");
		// Deployment credentials: the values sent now, else the ones kept, for the headers still listed.
		const sent = deployValues(body);
		const kept = this.ctx.storage.kv.get<Record<string, string>>("deployAuth") ?? {};
		const values: Record<string, string> = {};
		for (const d of next.deploys) for (const a of d.auth) {
			const k = deployKey(d.name, a.host, a.header);
			const v = sent.get(k) ?? kept[k];
			if (v) values[k] = v;
		}
		this.ctx.storage.kv.put("deployAuth", values);
		if (typeof key === "string") {
			if (key) (this.ctx.storage.kv.put("apiKey", key), this.ctx.storage.kv.put("keyProvider", next.provider));
			else (this.ctx.storage.kv.delete("apiKey"), this.ctx.storage.kv.delete("keyProvider"));
		}
		await this.kick(); // a new key starts waiting tasks; autoFerge starts on pairs already in conflict
		return this.publicSettings();
	}

	// ---- deployments ----

	// For Outbound: the headers deployment `name` adds to requests to `hostname`.
	deployHeaders(name: string, hostname: string): [string, string][] {
		return deployHeaders(this.settings().deploys.find((d) => d.name === name), hostname, this.ctx.storage.kv.get<Record<string, string>>("deployAuth") ?? {});
	}

	// A deployment still "running" after its Box's 30-minute timeout lost its result.
	private reapDeploys() {
		this.sql.exec("UPDATE deploy SET status = 'failed', finished = ?, log = 'the deployment never reported back' WHERE status = 'running' AND started < ?", Date.now(), Date.now() - 40 * 60_000);
	}

	// A person runs deployment `name` on `bubble`'s code, at its commit now. The bubble must have
	// nothing queued, so what is deployed is what the bubble holds.
	async startDeploy(name: string, bubble: string, by: string): Promise<{ id: string } | { error: string }> {
		this.reapDeploys();
		const d = this.settings().deploys.find((x) => x.name === name);
		if (!d) return { error: "no such deployment: configure it in the repository's settings" };
		const b = this.bubbles().find((x) => x.id === bubble);
		if (!b) return { error: "no such bubble" };
		if (!b.visible || this.sql.exec("SELECT 1 FROM fork WHERE bubble = ? AND status = 'pending'", bubble).toArray().length) return { error: "that bubble is merging or has changes still queued; try again in a moment" };
		if (this.sql.exec("SELECT 1 FROM deploy WHERE name = ? AND bubble = ? AND status = 'running'", name, bubble).toArray().length) return { error: "that deployment is already running on this bubble" };
		const id = `d-${crypto.randomUUID().slice(0, 8)}`;
		this.sql.exec("INSERT INTO deploy (id, name, bubble, head, started, by) VALUES (?, ?, ?, '', ?, ?)", id, name, bubble, Date.now(), by);
		try {
			const head = await headOf(this.env, bubble);
			if (!head) throw new Error("the bubble has no commits");
			this.sql.exec("UPDATE deploy SET head = ? WHERE id = ?", head, id);
			const { url } = await authRemote(this.env, bubble, "read", 3600);
			await this.env.BOX.getByName(`deploy-${id}`).startCI({ repo: this.ctx.storage.kv.get<string>("repo")!, fork: bubble, head, remote: url, command: d.command, hosts: d.hosts, deploy: { id, name } });
		} catch (e) {
			this.deployDone(id, false, `couldn't start: ${e instanceof Error ? e.message : e}`);
		}
		return { id };
	}

	// A person cancels a running deployment. Its Box stops the command; if the Box has no job (it never
	// started, or already reported), the record is closed here.
	async cancelDeploy(id: string): Promise<{ ok: true } | { error: string }> {
		if (!this.sql.exec("SELECT 1 FROM deploy WHERE id = ? AND status = 'running'", id).toArray().length) return { error: "that deployment isn't running" };
		const stopped = await this.env.BOX.getByName(`deploy-${id}`).stopCI().catch(() => false);
		if (!stopped) this.deployDone(id, false, "cancelled by a person");
		return { ok: true };
	}

	deployDone(id: string, ok: boolean, log: string) {
		this.sql.exec("UPDATE deploy SET status = ?, finished = ?, log = ? WHERE id = ? AND status = 'running'", ok ? "succeeded" : "failed", Date.now(), log.slice(-8000), id);
	}

	// The repository's own API key, for Outbound and the Reviewer only (never sent to a sandbox or the
	// API's callers); null = no key, so no agent or review runs (blingo has no key of its own).
	credentials(): { provider: Provider; key: string } | null {
		const key = this.ctx.storage.kv.get<string>("apiKey");
		return key ? { provider: this.settings().provider, key } : null;
	}

	// The Reviewer's OpenRouter key: its own if set (a subscription token can't call the SDK), else the
	// repository's when that is an OpenRouter key. Never sent to a sandbox.
	reviewerKey(): string | null {
		const own = this.ctx.storage.kv.get<string>("reviewerKey");
		if (own) return own;
		const c = this.credentials();
		return c?.provider === "openrouter" ? c.key : null;
	}

	// How to run an agent of `role` here: its model (`model` if one was chosen for it), and whose API it talks to.
	agentConfig(role: Role, model?: string | null): { model: string; provider: Provider } {
		const s = this.settings();
		return { model: model || s.models[role] || this.env.MODEL, provider: this.credentials()?.provider ?? "claude-subscription" };
	}

	private loose(fork: string): Loose | undefined {
		return this.sql.exec<Loose>("SELECT * FROM loose WHERE fork = ?", fork).toArray()[0];
	}

	// When the alarm must look at loose forks again: a fork being placed now; a fork that can still be
	// pushed to every POLL_MS. null = nothing to look at.
	private nextLooseCheck(): number | null {
		const r = this.sql.exec<{ placing: number; polled: number }>("SELECT MAX(placing) AS placing, MAX(token IS NOT NULL) AS polled FROM loose").one();
		return r.placing ? Date.now() + 1_000 : r.polled ? Date.now() + POLL_MS : null;
	}

	// A push to loose notagent fork `fork` reached `head` (seen by checkLoose).
	async onPushed(fork: string, head: string) {
		const l = this.loose(fork);
		if (!l || l.placing || l.kind !== "notagent" || head === l.head) return;
		this.sql.exec("UPDATE loose SET head = ?, pushes = pushes + 1, reason = NULL WHERE fork = ?", head, fork);
		await this.newHead(fork);
	}

	// An agent finished on `fork` (its first run, or a CI fixer's). With CI off it is placed now (its
	// patch series `files`/`mbox`); with CI on it becomes a loose fork and its new head goes through CI.
	async submit(fork: string, files: string[], mbox: string): Promise<{ bubble: string | null } | { loose: true } | { error: string }> {
		const l = this.loose(fork);
		if (!l && !this.settings().ci.enabled) return this.place(fork, files, mbox);
		const head = await headOf(this.env, fork);
		if (!l) {
			const base = this.sql.exec<{ base_head: string | null }>("SELECT base_head FROM task WHERE fork = ?", fork).toArray()[0]?.base_head ?? "";
			this.sql.exec(
				"INSERT INTO loose (fork, base, head, expires, pushes, kind, agent_pushes) VALUES (?, ?, ?, 0, 1, 'agent', 1)",
				fork,
				base,
				head,
			);
		} else if (head === l.head) {
			// The fixer changed nothing; that attempt counts and the fork stays failed.
			this.sql.exec("UPDATE loose SET agent_pushes = agent_pushes + 1 WHERE fork = ?", fork);
			await this.failed(fork, ["the fix (it changed nothing)"]);
			return { loose: true };
		} else {
			this.sql.exec("UPDATE loose SET head = ?, pushes = pushes + 1, agent_pushes = agent_pushes + 1, reason = NULL WHERE fork = ?", head, fork);
		}
		await this.newHead(fork);
		return { loose: true };
	}

	// A loose fork has a new head. Without CI it is placed (an agent's always; a notagent's with
	// auto-placement on). With CI, its CI runs from scratch: the command in its own Box (none = passes).
	private async newHead(fork: string) {
		const s = this.settings();
		const l = this.loose(fork)!;
		if (!s.ci.enabled) {
			if (l.kind === "agent" || s.autoPlaceNotagents) await this.startPlacing(fork);
			return;
		}
		this.sql.exec("UPDATE loose SET ci = 'running', ci_log = NULL, review_auto = NULL, review_manual = NULL, review_note = NULL WHERE fork = ?", fork);
		if (!s.ci.command) return this.ciDone(fork, l.head, true, "");
		const { url } = await authRemote(this.env, fork, "read", 3600);
		await this.env.BOX.getByName(`ci-${fork}`).startCI({ repo: this.ctx.storage.kv.get<string>("repo")!, fork, head: l.head, remote: url, command: s.ci.command, hosts: s.ci.hosts });
	}

	// CI finished for `fork` at `head` (stale results, for an older head, are dropped). On success the
	// required reviews start: the Reviewer agent gets the task and the fork's patch series.
	async ciDone(fork: string, head: string, ok: boolean, log: string) {
		const l = this.loose(fork);
		if (!l || l.head !== head || l.ci !== "running") return;
		this.sql.exec("UPDATE loose SET ci = ?, ci_log = ? WHERE fork = ?", ok ? "passed" : "failed", log.slice(-8000), fork);
		const review = this.settings().review;
		if (ok && (review === "manual" || review === "both")) this.sql.exec("UPDATE loose SET review_manual = 'pending' WHERE fork = ?", fork);
		if (ok && (review === "auto" || review === "both")) {
			this.sql.exec("UPDATE loose SET review_auto = 'pending' WHERE fork = ?", fork);
			const t = this.sql.exec<{ title: string; description: string }>("SELECT title, description FROM task WHERE fork = ?", fork).toArray()[0];
			const { url } = await authRemote(this.env, fork, "read");
			const p = await this.box().sh(PATCH_SH, [url, l.base]);
			const series = p.exitCode === 0 ? readSeries(p.stdout).mbox : `(no patch series: ${p.stderr.slice(-500)})`;
			const reviewer = await getAgentByName(this.env.REVIEWER, fork);
			await reviewer.start({ repo: this.ctx.storage.kv.get<string>("repo")!, fork, head, title: t?.title ?? "", description: t?.description ?? "", series, model: this.agentConfig("agent").model });
		}
		await this.evaluate(fork);
	}

	// The Reviewer agent's verdict for `fork` at `head`.
	async reviewDone(fork: string, head: string, approve: boolean, comments: string) {
		const l = this.loose(fork);
		if (!l || l.head !== head || l.review_auto !== "pending") return;
		this.sql.exec("UPDATE loose SET review_auto = ?, review_note = COALESCE(review_note || '\n\n', '') || ? WHERE fork = ?", approve ? "approved" : "rejected", `Automatic review: ${comments}`, fork);
		await this.evaluate(fork);
	}

	// A person's review of a loose fork waiting for one.
	async review(fork: string, approve: boolean, comment: string): Promise<{ ok: true } | { error: string }> {
		const l = this.loose(fork);
		if (!l || l.review_manual !== "pending") return { error: "that fork isn't waiting for a review" };
		const note = comment ? `Manual review: ${comment}` : `Manual review: ${approve ? "approved" : "rejected"}`;
		this.sql.exec("UPDATE loose SET review_manual = ?, review_note = COALESCE(review_note || '\n\n', '') || ? WHERE fork = ?", approve ? "approved" : "rejected", note, fork);
		await this.evaluate(fork);
		return { ok: true };
	}

	// After each CI step: passed → placed (an agent's always; a notagent's with auto-placement on, else
	// on request); failed → a fixer agent for an agent's fork, or the human's next push.
	private async evaluate(fork: string) {
		const s = this.settings();
		const l = this.loose(fork)!;
		const g = gate(s, ciState(l));
		if (g === "waiting") return;
		if (g !== "passed") return this.failed(fork, g.failed);
		this.sql.exec("UPDATE loose SET reason = NULL WHERE fork = ?", fork);
		if (l.kind === "agent" || s.autoPlaceNotagents) await this.startPlacing(fork);
	}

	// A CI step failed. An agent's fork gets a fixer agent while it has pushes left; then it becomes a
	// notagent's (its task too), for a person to push the fix.
	private async failed(fork: string, steps: string[]) {
		const s = this.settings();
		const l = this.loose(fork)!;
		const reason = `${steps.map((s) => (s === "ci" ? "CI" : s)).join(" and ")} failed`;
		this.sql.exec("UPDATE loose SET reason = ? WHERE fork = ?", reason, fork);
		if (l.kind !== "agent") return;
		if (l.agent_pushes < s.maxAgentPushes) return this.startFixer(fork, steps);
		this.toNotagent(fork, `${reason}; the agent used all ${s.maxAgentPushes} of its pushes, so a person takes over`);
	}

	private toNotagent(fork: string, reason: string) {
		this.sql.exec("UPDATE loose SET kind = 'notagent', reason = ? WHERE fork = ?", reason, fork);
		this.sql.exec("UPDATE task SET kind = 'notagent' WHERE fork = ?", fork);
	}

	// A new agent run on the same fork, told what the task was and what failed.
	private async startFixer(fork: string, steps: string[]) {
		const l = this.loose(fork)!;
		const t = this.sql.exec<{ title: string; description: string; model: string | null; skills: string | null }>("SELECT title, description, model, skills FROM task WHERE fork = ?", fork).toArray()[0];
		const repo = this.ctx.storage.kv.get<string>("repo")!;
		const run = `${fork}-c${l.agent_pushes}`;
		if (!this.credentials()) return this.toNotagent(fork, `${l.reason ?? "CI failed"}; no fixer agent: ${NO_KEY}, so a person takes over`);
		const prompt = fixPrompt({ title: t?.title ?? "", description: t?.description ?? "", failed: steps, command: this.settings().ci.command, log: l.ci_log, review: l.review_note });
		try {
			const { url } = await authRemote(this.env, fork, "write", 3 * 3600);
			await this.env.BOX.getByName(run).startAgent({ repo, fork, run, remote: url, prompt, kind: "agent", memory: this.memories(), skills: this.skillPack(t?.skills ?? null), ...this.agentConfig("agent", t?.model) });
			this.agentStarted(run, `Fix: ${t?.title ?? fork}`);
		} catch (e) {
			console.error(`starting fixer ${run}`, e);
			this.toNotagent(fork, `${l.reason ?? "CI failed"}; its fixer agent couldn't start, so a person takes over`);
		}
	}

	// Someone asks for a loose fork to be placed: it must have been pushed to and, with CI on, passed.
	async requestPlacement(fork: string): Promise<{ ok: true } | { error: string }> {
		const l = this.loose(fork);
		if (!l) return { error: "no such loose fork" };
		if (l.placing) return { error: "it is already being placed" };
		if (!l.pushes) return { error: "nothing has been pushed to it yet" };
		if (gate(this.settings(), ciState(l)) !== "passed") return { error: "it hasn't passed CI" };
		await this.startPlacing(fork);
		return { ok: true };
	}

	private async startPlacing(fork: string) {
		const l = this.loose(fork);
		this.sql.exec("UPDATE loose SET placing = 1, token = NULL WHERE fork = ?", fork);
		if (l?.token) {
			using repo = await this.env.ARTIFACTS.get(fork);
			await repo.revokeToken(l.token).catch(() => false);
		}
		await this.kick();
	}

	// A fresh 1-hour push token for a notagent's loose fork that isn't being placed (its old one
	// expired, or it needs another push).
	async pushToken(fork: string) {
		const l = this.sql.exec<Loose>("SELECT * FROM loose WHERE fork = ? AND placing = 0", fork).toArray()[0];
		if (!l) return { error: "no such loose fork" };
		if (l.kind !== "notagent") return { error: "an agent is working on that fork" };
		const { url: authed, remote, token } = await authRemote(this.env, fork, "write", 3600);
		this.sql.exec("UPDATE loose SET token = ?, expires = ? WHERE fork = ?", token.id, Date.parse(token.expiresAt), fork);
		await this.kick();
		return { repo: this.ctx.storage.kv.get<string>("repo"), fork, remote, token: token.plaintext, clone: `git clone --single-branch ${authed} ${fork}`, push: `git push ${authed} HEAD:main` };
	}

	// Loose forks with a live token are polled for a push. Once a token expires, a fork with no push is
	// deleted and its task reopened; one with pushes stays loose. Then every fork marked placing is
	// placed, in parallel: the repo's git Box turns it into its patch series and place() queues it. A
	// failed placement leaves it loose with the reason; infra errors are retried.
	// ponytail: polling (Artifacts push subscriptions take up to a minute to go live); pushes inside
	// one 5 s window count as one.
	private async checkLoose() {
		const now = Date.now();
		await Promise.all(
			this.sql
				.exec<Loose>("SELECT * FROM loose WHERE placing = 0 AND token IS NOT NULL")
				.toArray()
				.map(async (l) => {
					const head = await headOf(this.env, l.fork);
					if (head !== l.head) return this.onPushed(l.fork, head);
					if (now < l.expires) return;
					if (l.pushes) return void this.sql.exec("UPDATE loose SET token = NULL WHERE fork = ?", l.fork);
					// Nothing was pushed, so no work is lost: the task can be taken again.
					this.sql.exec("DELETE FROM loose WHERE fork = ?", l.fork);
					this.sql.exec("DELETE FROM basis WHERE fork = ?", l.fork);
					this.sql.exec("UPDATE task SET status = 'open', fork = NULL, base_head = NULL WHERE fork = ? AND status = 'in-progress'", l.fork);
					await this.env.ARTIFACTS.delete(l.fork);
				}),
		);
		const results = await Promise.allSettled(
			this.sql
				.exec<Loose>("SELECT * FROM loose WHERE placing = 1")
				.toArray()
				.map(async (l) => {
					let placed: { bubble: string | null } | { error: string };
					try {
						const { url } = await authRemote(this.env, l.fork, "read");
						const p = await this.box().sh(PATCH_SH, [url, l.base]);
						if (p.exitCode !== 0 && p.exitCode !== MERGES && p.exitCode !== UNBASED) throw new Error(`patch series of ${l.fork} (${p.exitCode}): ${p.stderr}`);
						placed =
							p.exitCode === MERGES
								? { error: "its history has merge commits; rebase it onto where it started" }
								: p.exitCode === UNBASED
									? { error: "its history doesn't contain the commit it started from (force-pushed?); rebase it onto that commit" }
									: await this.place(l.fork, readSeries(p.stdout).files, readSeries(p.stdout).mbox);
					} catch (e) {
						// Infra errors are retried, but not forever: then it is loose, with the error as its reason.
						const n = (this.placeFails.get(l.fork) ?? 0) + 1;
						this.placeFails.set(l.fork, n);
						if (n < PLACE_TRIES) throw e;
						placed = { error: `placement kept failing: ${String(e).slice(-1500)}` };
					}
					this.placeFails.delete(l.fork);
					if ("error" in placed) this.sql.exec("UPDATE loose SET placing = 0, reason = ? WHERE fork = ?", placed.error, l.fork);
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
			.exec<{ name: string; bubble: string; diff: string | null; kind: string | null; role: string | null }>(
				"SELECT f.name, f.bubble, f.diff, t.kind, t.role FROM fork f JOIN bubble b ON b.id = f.bubble LEFT JOIN task t ON t.fork = f.name WHERE f.status = 'pending' AND b.visible = 1 ORDER BY f.rowid",
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
					this.sql.exec("UPDATE fork SET status = ?, seq = ? WHERE name = ?", r.ok ? "merged" : "conflict", r.ok ? this.nextSeq() : null, f.name);
					this.putDiff(f.name, r.diff);
					if (r.ok) await this.env.ARTIFACTS.delete(f.name).catch(() => false);
				}
				const series = forks.filter((f) => f.diff !== null);
				if (!series.length) return;
				const ok = await box.apply(
					url,
					series.map((f) => ({ fork: f.name, mbox: this.diff(f.name)!, committer: { name: f.name, email: `${f.kind === "notagent" ? "notagent" : "agent"}@${domain}` } })),
				);
				series.forEach((f, i) => {
					if (!ok[i]) console.error(`series of ${f.name} did not apply to ${bubble}`);
					this.sql.exec("UPDATE fork SET status = ?, seq = ? WHERE name = ?", ok[i] ? "merged" : "failed", ok[i] ? this.nextSeq() : null, f.name);
					// A ferge agent's resolution has landed in its bubble: the conflicts are gone, so unlock it.
					if (ok[i] && f.role === "ferge") this.sql.exec("DELETE FROM locked WHERE id = ?", bubble);
				});
				// The applied forks' envs join the bubble's; then their repos go (a fork from before forks were
				// kept until applied has none left: skipped).
				const landed = await Promise.all(series.filter((_, i) => ok[i]).map((f) => authRemote(this.env, f.name, "read").then((r) => r.url, () => null)));
				await box.mergeEnv(url, landed.filter((u) => u !== null));
				await Promise.all(series.map((f) => this.env.ARTIFACTS.delete(f.name).catch(() => false)));
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
					await this.bubbleBox(h.id).mergeEnv(rep.url, [src.url]);
					this.absorb(h.id, nb);
					this.sql.exec("UPDATE fork SET status = 'merged', seq = ? WHERE name = ?", this.nextSeq(), nb);
					this.putDiff(nb, r.diff);
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
		return this.autoFerge(conflicts, busy);
	}

	// With the setting autoFerge: no neighbour merge to do, so ferge one conflicting pair that can be
	// (both visible, unlocked, nothing queued). A pair that no longer conflicts loses its conflict
	// record, so the loop merges it normally instead of trying again. Returns whether it did either.
	private async autoFerge(conflicts: Set<string>, busy: Set<string>): Promise<boolean> {
		const repo = this.ctx.storage.kv.get<string>("repo");
		const pair = repo && this.settings().autoFerge ? fergeCandidate([...conflicts], this.bubbles(), busy) : null;
		if (!pair) return false;
		const r = await this.ferge(repo!, ...pair);
		if (!("error" in r)) return true;
		console.error(`auto-ferge ${pair.join(" / ")}: ${r.error}`);
		if (r.error !== NO_LONGER_CONFLICT) return false;
		this.sql.exec("DELETE FROM conflict WHERE k = ?", conflictKey(...pair));
		return true;
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
