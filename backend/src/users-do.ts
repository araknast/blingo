import { DurableObject } from "cloudflare:workers";
import { checkPassword, hashPassword, randomToken, type Signup } from "./auth";

const DAY = 24 * 3600 * 1000;

// The only instance: env.USERS.getByName("users"). Accounts, invites, sessions, repo owners.
// Every check-then-write is one call here, so DO serialization makes them race-free.
// ponytail: one global object; shard by username if signups/logins ever outgrow it.
export class UsersDO extends DurableObject<Env> {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS user(name TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, salt TEXT NOT NULL, created INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS pending(token TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, hash TEXT NOT NULL,
				salt TEXT NOT NULL, invite TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS invite(code TEXT PRIMARY KEY, created INTEGER NOT NULL, used_by TEXT);
			CREATE TABLE IF NOT EXISTS session(token TEXT PRIMARY KEY, name TEXT NOT NULL, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS repo(name TEXT PRIMARY KEY, owner TEXT NOT NULL);
		`);
	}

	private one<T extends Record<string, SqlStorageValue>>(q: string, ...args: SqlStorageValue[]): T | undefined {
		return this.sql.exec<T>(q, ...args).toArray()[0];
	}

	// Why this signup can't go ahead (invite spent, name/email taken), or null.
	private blocked(s: { invite: string; username: string; email: string }): string | null {
		if (!this.one("SELECT 1 FROM invite WHERE code = ? AND used_by IS NULL", s.invite)) return "invalid or used invite";
		if (this.one("SELECT 1 FROM user WHERE name = ?", s.username)) return "username taken";
		if (this.one("SELECT 1 FROM user WHERE email = ?", s.email)) return "email already registered";
		return null;
	}

	// Records an unverified signup; the account is created by verify(). Returns the verify token.
	async signup(s: Signup): Promise<{ token: string } | { error: string }> {
		const email = s.email.toLowerCase();
		const why = this.blocked({ ...s, email });
		if (why) return { error: why };
		const { hash, salt } = await hashPassword(s.password);
		const token = randomToken();
		this.sql.exec("DELETE FROM pending WHERE expires < ?", Date.now());
		this.sql.exec(
			"INSERT INTO pending (token, name, email, hash, salt, invite, expires) VALUES (?, ?, ?, ?, ?, ?, ?)",
			token, s.username, email, hash, salt, s.invite, Date.now() + DAY,
		);
		return { token };
	}

	// Creates the account and spends the invite. Re-checks: another signup may have won meanwhile.
	verify(token: string): { username: string } | { error: string } {
		type P = { name: string; email: string; hash: string; salt: string; invite: string; expires: number };
		const p = this.one<P>("SELECT name, email, hash, salt, invite, expires FROM pending WHERE token = ?", token);
		if (!p || p.expires < Date.now()) return { error: "link invalid or expired" };
		const why = this.blocked({ invite: p.invite, username: p.name, email: p.email });
		if (why) return { error: why };
		this.sql.exec("INSERT INTO user (name, email, hash, salt, created) VALUES (?, ?, ?, ?, ?)", p.name, p.email, p.hash, p.salt, Date.now());
		this.sql.exec("UPDATE invite SET used_by = ? WHERE code = ?", p.name, p.invite);
		this.sql.exec("DELETE FROM pending WHERE name = ? OR email = ? OR invite = ?", p.name, p.email, p.invite);
		return { username: p.name };
	}

	// ponytail: no rate limit; PBKDF2 slows guessing. Add a Workers rate-limit binding if abused.
	async login(name: string, password: string): Promise<string | null> {
		const u = this.one<{ hash: string; salt: string }>("SELECT hash, salt FROM user WHERE name = ?", name);
		if (!u || !(await checkPassword(password, u.hash, u.salt))) return null;
		const token = randomToken();
		this.sql.exec("DELETE FROM session WHERE expires < ?", Date.now());
		this.sql.exec("INSERT INTO session (token, name, expires) VALUES (?, ?, ?)", token, name, Date.now() + 30 * DAY);
		return token;
	}

	logout(token: string) {
		this.sql.exec("DELETE FROM session WHERE token = ?", token);
	}

	whoami(token: string): string | null {
		return this.one<{ name: string }>("SELECT name FROM session WHERE token = ? AND expires > ?", token, Date.now())?.name ?? null;
	}

	mintInvite(): string {
		const code = randomToken().slice(0, 16);
		this.sql.exec("INSERT INTO invite (code, created) VALUES (?, ?)", code, Date.now());
		return code;
	}

	own(repo: string, owner: string) {
		this.sql.exec("INSERT INTO repo (name, owner) VALUES (?, ?)", repo, owner);
	}

	ownerOf(repo: string): string | null {
		return this.one<{ owner: string }>("SELECT owner FROM repo WHERE name = ?", repo)?.owner ?? null;
	}

	reposOf(owner: string): string[] {
		return this.sql.exec<{ name: string }>("SELECT name FROM repo WHERE owner = ? ORDER BY name", owner).toArray().map((r) => r.name);
	}

	disown(repo: string) {
		this.sql.exec("DELETE FROM repo WHERE name = ?", repo);
	}
}
