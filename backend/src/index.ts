import { invalidSignup, type Signup } from "./auth";
import { authRemote } from "./box";
import { diffTrees, resolvePath } from "./git";

export { Box, Outbound } from "./box";
export { RepoDO } from "./repo-do";
export { UsersDO } from "./users-do";

const id = () => crypto.randomUUID().slice(0, 8);

type Body = { prompt?: string; repo?: string; bubble?: string };
type Auth = { user: string; admin: boolean };

const users = (env: Env) => env.USERS.getByName("users");
const noRepo = () => Response.json({ error: "no such repository" }, { status: 404 });

// Owner-only: other users get the same 404 as a missing repo. Unowned (pre-users) repos are admin-only.
async function canUse(env: Env, auth: Auth, repo: string) {
	return auth.admin || (await users(env).ownerOf(repo)) === auth.user;
}

// Where a new fork comes from. No repo → brand-new repository (design: "a new repository is created").
async function source(env: Env, auth: Auth, b: Body): Promise<{ repo: string; from: string } | Response> {
	if (!b.repo) {
		const repo = await createRepo(env, auth);
		return { repo, from: repo };
	}
	if (!(await canUse(env, auth, b.repo))) return noRepo();
	const repoDO = env.REPO.getByName(b.repo);
	// No bubble named → any bubble; the base repo only while the repository has none.
	if (!b.bubble) return { repo: b.repo, from: (await repoDO.anyBubble()) ?? b.repo };
	const rep = await repoDO.repOf(b.bubble);
	return rep ? { repo: b.repo, from: rep } : Response.json({ error: "no such bubble" }, { status: 404 });
}

async function createRepo(env: Env, auth: Auth) {
	const repo = `r-${id()}`;
	await env.ARTIFACTS.create(repo, { setDefaultBranch: "main" });
	await users(env).own(repo, auth.user);
	return repo;
}

async function fork(env: Env, from: string, repo: string) {
	const name = `${repo}-f-${id()}`;
	using src = await env.ARTIFACTS.get(from);
	await src.fork(name, { defaultBranchOnly: true });
	return name;
}

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (e) {
			// Artifacts fails transiently under load (seen: parallel forks of one repo). Tell clients to retry.
			if ((e as ArtifactsError)?.name === "ArtifactsError" && (e as ArtifactsError).code === "INTERNAL_ERROR") {
				return Response.json({ error: "storage busy, retry" }, { status: 503, headers: { "retry-after": "2" } });
			}
			throw e;
		}
	},
} satisfies ExportedHandler<Env>;

async function sendVerify(env: Env, to: string, link: string) {
	try {
		await env.EMAIL.send({
			to,
			from: { email: env.EMAIL_FROM, name: "blingo" },
			subject: "Verify your blingo account",
			text: `Open this link to create your blingo account (valid 24 hours):\n\n${link}\n`,
			html: `<p>Open this link to create your blingo account (valid 24 hours):</p><p><a href="${link}">${link}</a></p>`,
		});
		return true;
	} catch (e) {
		console.error("verification email failed", e, link); // the link in the log lets local dev continue
		return false;
	}
}

const page = (msg: string, status = 200) =>
	new Response(`<!doctype html><meta charset="utf-8"><title>blingo</title><p>${msg}</p><p><a href="/login">Log in</a></p>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8" },
	});

// Bearer is a session token, or BLINGO_TOKEN, which acts as the admin account (bootstrap and scripts).
async function authenticate(request: Request, env: Env): Promise<Auth | null> {
	const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
	if (!token) return null;
	if (token === env.BLINGO_TOKEN) return { user: env.ADMIN_USERNAME, admin: true };
	const user = await users(env).whoami(token);
	return user ? { user, admin: user === env.ADMIN_USERNAME } : null;
}

async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const [, a, b, c, d, e] = url.pathname.split("/");

	// Open routes: invite-only signup, email verification, login.
	if (request.method === "POST" && a === "signup" && !b) {
		const s = (await request.json()) as Partial<Signup>;
		const bad = invalidSignup(s);
		if (bad) return Response.json({ error: bad }, { status: 400 });
		const r = await users(env).signup(s as Signup);
		if ("error" in r) return Response.json(r, { status: 409 });
		const sent = await sendVerify(env, s.email!, `${url.origin}/verify?token=${r.token}`);
		return sent
			? Response.json({ sent: true }, { status: 202 })
			: Response.json({ error: "could not send verification email" }, { status: 502 });
	}
	if (request.method === "GET" && a === "verify" && !b) {
		const r = await users(env).verify(url.searchParams.get("token") ?? "");
		return "error" in r ? page(`Verification failed: ${r.error}.`, 400) : page(`Account <b>${r.username}</b> created.`);
	}
	if (request.method === "POST" && a === "login" && !b) {
		const { username, password } = (await request.json()) as { username?: string; password?: string };
		const token = typeof username === "string" && typeof password === "string" && (await users(env).login(username, password));
		return token
			? Response.json({ token, username, admin: username === env.ADMIN_USERNAME })
			: Response.json({ error: "wrong username or password" }, { status: 401 });
	}

	// Everything else mints git tokens or starts paid runs, so it is never open.
	const auth = await authenticate(request, env);
	if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });

	if (request.method === "GET" && a === "me" && !b) {
		return Response.json({ username: auth.user, admin: auth.admin, repos: await users(env).reposOf(auth.user) });
	}
	if (request.method === "POST" && a === "logout" && !b) {
		await users(env).logout(request.headers.get("authorization")!.slice("Bearer ".length));
		return Response.json({ ok: true });
	}
	if (request.method === "POST" && a === "invites" && !b) {
		if (!auth.admin) return Response.json({ error: "admin only" }, { status: 403 });
		return Response.json({ code: await users(env).mintInvite() }, { status: 201 });
	}
	// Repository routes: the repo is the path segment, or the prefix of a fork name.
	if (a === "repos" && b && !(await canUse(env, auth, b))) return noRepo();
	if (a === "agents" && b && !(await canUse(env, auth, b.split("-f-")[0]))) return noRepo();

	if (request.method === "POST" && (a === "agents" || a === "notagents") && !b) {
		const body = (await request.json()) as Body;
		if (a === "agents" && !body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });
		const src = await source(env, auth, body);
		if (src instanceof Response) return src;
		const name = await fork(env, src.from, src.repo);

		if (a === "agents") {
			const { url: remote } = await authRemote(env, name, "write", 3 * 3600);
			await env.BOX.getByName(name).startAgent({ repo: src.repo, fork: name, remote, prompt: body.prompt! });
			await env.REPO.getByName(src.repo).agentStarted(name, body.prompt!);
			return Response.json({ repo: src.repo, fork: name }, { status: 202 });
		}

		using repo = await env.ARTIFACTS.get(name);
		const base = (await repo.log({ limit: 1 }))[0]?.hash ?? "";
		const { url: authed, remote, token } = await authRemote(env, name, "write", 3600);
		await env.REPO.getByName(src.repo).watch(name, base, token.id, Date.parse(token.expiresAt));
		return Response.json(
			{ repo: src.repo, fork: name, remote, token: token.plaintext, clone: `git clone ${authed} ${name}`, push: `git push ${authed} HEAD:main` },
			{ status: 201 },
		);
	}

	if (request.method === "POST" && a === "repos" && !b) {
		return Response.json({ repo: await createRepo(env, auth) }, { status: 201 });
	}
	// Code browser: tree, log, commit and blob reads of a fork (or of the bubble a merged fork joined).
	if (request.method === "GET" && a === "repos" && b && c && d) {
		const from = await env.REPO.getByName(b).readFrom(c);
		if (!from) return Response.json({ error: "no such fork" }, { status: 404 });
		using repo = await env.ARTIFACTS.get(from);
		const readTree = (h: string) => repo.readTree(h);
		const q = url.searchParams;
		if (d === "tree" && !e) {
			const commit = (await repo.log({ ref: q.get("ref") || "main", limit: 1 }))[0];
			if (!commit) return Response.json({ commit: null, entries: [] }); // nothing pushed yet
			const at = await resolvePath(readTree, commit.treeHash, q.get("path") ?? "");
			if (at?.type !== "tree") return Response.json({ error: "no such directory" }, { status: 404 });
			return Response.json({ commit, entries: await repo.readTree(at.hash) });
		}
		if (d === "log" && !e) {
			const limit = Math.min(Number(q.get("limit")) || 30, 100);
			return Response.json(await repo.log({ ref: q.get("ref") || "main", limit, offset: Number(q.get("offset")) || 0 }));
		}
		if (d === "commits" && e && /^[0-9a-f]{40}$/.test(e)) {
			const commit = await repo.readCommit(e);
			if (!commit) return Response.json({ error: "no such commit" }, { status: 404 });
			const parent = commit.parents[0] ? await repo.readCommit(commit.parents[0]) : null;
			return Response.json({ commit, files: await diffTrees(readTree, parent?.treeHash ?? null, commit.treeHash) });
		}
		if (d === "blob" && e && /^[0-9a-f]{40}$/.test(e)) {
			const blob = await repo.readBlob(e);
			return blob === null ? new Response("no such blob\n", { status: 404 }) : new Response(blob);
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	if (request.method === "GET" && a === "agents" && b) return Response.json(await env.BOX.getByName(b).status());
	if (request.method === "GET" && a === "repos" && b && !c) return Response.json(await env.REPO.getByName(b).list());
	if (request.method === "DELETE" && a === "repos" && b && !c) {
		const deleted = await env.REPO.getByName(b).destroy(b);
		await users(env).disown(b);
		return Response.json({ deleted });
	}
	if (request.method === "POST" && a === "repos" && b && (c === "lock" || c === "unlock")) {
		const { bubble } = (await request.json()) as { bubble: string };
		const repo = env.REPO.getByName(b);
		const ok = c === "lock" ? await repo.lock(bubble) : await repo.unlock(bubble);
		return ok ? Response.json({ bubble, locked: c === "lock" }) : Response.json({ error: "no such bubble" }, { status: 404 });
	}
	if (request.method === "POST" && a === "repos" && b && c === "ferge") {
		const body = (await request.json()) as { a: string; b: string };
		const r = await env.REPO.getByName(b).ferge(b, body.a, body.b);
		return "error" in r ? Response.json(r, { status: 409 }) : Response.json(r);
	}
	if (request.method === "GET" && a === "repos" && b && c && url.searchParams.has("path")) {
		const from = await env.REPO.getByName(b).readFrom(c);
		if (!from) return new Response("no such fork\n", { status: 404 });
		using repo = await env.ARTIFACTS.get(from);
		const file = await repo.readFile({ ref: url.searchParams.get("ref") || "main", path: url.searchParams.get("path")! });
		return file === null
			? new Response("file not present\n", { status: 404 })
			: new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } });
	}
	if (request.method === "GET" && a === "repos" && b && c) {
		const diff = await env.REPO.getByName(b).diff(c);
		return diff === null ? new Response("no diff\n", { status: 404 }) : new Response(diff);
	}
	return Response.json({ error: "not found" }, { status: 404 });
}
