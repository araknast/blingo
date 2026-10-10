import { invalidSignup, type Signup } from "./auth";
import { authRemote } from "./box";
import { diffTrees, resolvePath } from "./git";
import { friendlyName, nameText, repoName } from "./names";
import { NO_KEY } from "./settings";
import { shortTitle } from "./tasks";

export { Box, Outbound } from "./box";
export { RepoDO } from "./repo-do";
export { Reviewer } from "./reviewer";
export { UsersDO } from "./users-do";

const id = () => crypto.randomUUID().slice(0, 8);

type Body = { prompt?: string; title?: string; description?: string; repo?: string; bubble?: string; name?: string };
type Auth = { user: string; admin: boolean };

const users = (env: Env) => env.USERS.getByName("users");
const noRepo = () => Response.json({ error: "no such repository" }, { status: 404 });

// Owner-only: other users get the same 404 as a missing repo. Unowned (pre-users) repos are admin-only.
async function canUse(env: Env, auth: Auth, repo: string) {
	return auth.admin || (await users(env).ownerOf(repo)) === auth.user;
}

// Where new work starts. No repo → brand-new repository (design: "a new repository is created").
// bubble null = any bubble (the base repo only while the repository has none).
async function source(env: Env, auth: Auth, b: Body): Promise<{ repo: string; bubble: string | null } | Response> {
	if (!b.repo) return { repo: await createRepo(env, auth, repoName(b.name) ?? repoName(b.title)), bubble: null };
	if (!(await canUse(env, auth, b.repo))) return noRepo();
	if (!b.bubble) return { repo: b.repo, bubble: null };
	const rep = await env.REPO.getByName(b.repo).repOf(b.bubble);
	return rep ? { repo: b.repo, bubble: rep } : Response.json({ error: "no such bubble" }, { status: 404 });
}

// Agents run only on their repository's own key, so a request without a repo (a brand-new one) can't
// start one. Access is checked by source() right after.
const hasKey = async (env: Env, b: Body) => !!b.repo && (await env.REPO.getByName(b.repo).publicSettings()).hasKey;

// `name`: its display name (a friendly "adjective noun" if none); its first bubble is called after it.
async function createRepo(env: Env, auth: Auth, name: string | null = null) {
	const repo = `r-${id()}`;
	const title = name ?? nameText(friendlyName());
	await env.ARTIFACTS.create(repo, { setDefaultBranch: "main" });
	await users(env).own(repo, auth.user, title);
	await env.REPO.getByName(repo).setName(title);
	return repo;
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
		const u = users(env);
		return Response.json({ username: auth.user, admin: auth.admin, repos: await u.reposOf(auth.user), names: await u.titlesOf(auth.user) });
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
	// Agent runs are forks (-f-) or superagent runs (-s-) of a repo.
	if (a === "agents" && b && !(await canUse(env, auth, b.split(/-[fs]-/)[0]))) return noRepo();

	// Every agent and notagent belongs to a task: these add a one-task batch and start it now.
	if (request.method === "POST" && (a === "agents" || a === "notagents") && !b) {
		const body = (await request.json()) as Body;
		const description = (a === "agents" ? body.prompt : body.description)?.trim();
		if (!description) return Response.json({ error: a === "agents" ? "prompt required" : "description required" }, { status: 400 });
		if (a === "agents" && !(await hasKey(env, body))) return Response.json({ error: NO_KEY }, { status: 400 });
		const src = await source(env, auth, body);
		if (src instanceof Response) return src;
		const repoDO = env.REPO.getByName(src.repo);
		const kind = a === "agents" ? "agent" : "notagent";
		const title = shortTitle(body.title?.trim() || description);
		const added = await repoDO.addTasks(src.repo, [{ title, description, kind, deps: [], bubble: src.bubble }]);
		if ("error" in added) return Response.json(added, { status: 400 });
		const [task] = added.ids;
		if ((await repoDO.task(task))?.status === "awaiting-approval") return Response.json({ repo: src.repo, task, awaitingApproval: true }, { status: 202 });
		if (a === "notagents") {
			const r = await repoDO.takeTask(task);
			return "error" in r ? Response.json(r, { status: 409 }) : Response.json(r, { status: 201 });
		}
		// fork null: the start failed and the task is queued; RepoDO retries it.
		return Response.json({ repo: src.repo, task, fork: (await repoDO.task(task))?.fork ?? null }, { status: 202 });
	}

	// Superagent: plans a prompt into tasks on a read-only clone; the tasks appear when it finishes.
	if (request.method === "POST" && a === "superagents" && !b) {
		const body = (await request.json()) as Body;
		const prompt = body.prompt?.trim();
		if (!prompt) return Response.json({ error: "prompt required" }, { status: 400 });
		if (!(await hasKey(env, body))) return Response.json({ error: NO_KEY }, { status: 400 });
		const src = await source(env, auth, body);
		if (src instanceof Response) return src;
		const repoDO = env.REPO.getByName(src.repo);
		const run = `${src.repo}-s-${id()}`;
		const from = src.bubble ?? (await repoDO.anyBubble()) ?? src.repo;
		const { url: remote } = await authRemote(env, from, "read", 3 * 3600);
		const memory = await repoDO.memories();
		const config = await repoDO.agentConfig("superagent");
		await env.BOX.getByName(run).startAgent({ repo: src.repo, fork: run, remote, prompt, kind: "superagent", memory, ...config });
		await repoDO.agentStarted(run, prompt);
		return Response.json({ repo: src.repo, superagent: run }, { status: 202 });
	}

	if (request.method === "POST" && a === "repos" && !b) {
		const body = (await request.json().catch(() => ({}))) as Body;
		if (body.name !== undefined && !repoName(body.name)) return Response.json({ error: "name must be 1 to 60 characters" }, { status: 400 });
		return Response.json({ repo: await createRepo(env, auth, repoName(body.name)) }, { status: 201 });
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

	if (request.method === "GET" && a === "agents" && b && c === "transcript" && !d) return Response.json(await env.BOX.getByName(b).transcript(Number(url.searchParams.get("from"))));
	if (request.method === "GET" && a === "agents" && b && !c) return Response.json(await env.BOX.getByName(b).status());
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
	// One task, as an issue tracker files it: an agent task starts once ready; a human one waits to be taken.
	if (request.method === "POST" && a === "repos" && b && c === "tasks" && !d) {
		const t = (await request.json()) as { title?: string; description?: string; kind?: string; deps?: unknown; bubble?: string };
		const title = t.title?.trim() ? shortTitle(t.title) : "";
		const description = t.description?.trim() ?? "";
		const deps = t.deps ?? [];
		if (!title) return Response.json({ error: "title required" }, { status: 400 });
		if (t.kind !== "agent" && t.kind !== "notagent") return Response.json({ error: "kind must be agent or notagent" }, { status: 400 });
		if (!Array.isArray(deps) || deps.some((x) => typeof x !== "string")) return Response.json({ error: "deps must be task ids" }, { status: 400 });
		const repoDO = env.REPO.getByName(b);
		if (t.bubble && !(await repoDO.repOf(t.bubble))) return Response.json({ error: "no such bubble" }, { status: 404 });
		const added = await repoDO.addTasks(b, [{ title, description: description || title, kind: t.kind, deps, bubble: t.bubble ?? null }]);
		return "error" in added ? Response.json(added, { status: 400 }) : Response.json({ task: added.ids[0] }, { status: 201 });
	}
	if (request.method === "PATCH" && a === "repos" && b && c === "tasks" && d && !e) {
		const t = (await request.json()) as { title?: unknown; description?: unknown };
		if (t.title !== undefined && (typeof t.title !== "string" || !t.title.trim())) return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
		if (t.description !== undefined && typeof t.description !== "string") return Response.json({ error: "description must be a string" }, { status: 400 });
		const r = await env.REPO.getByName(b).editTask(d, t.title === undefined ? undefined : shortTitle(t.title as string), (t.description as string | undefined)?.trim());
		return "error" in r ? Response.json(r, { status: 409 }) : Response.json({ task: d });
	}
	if (request.method === "POST" && a === "repos" && b && c === "tasks" && d && e === "approve") {
		return (await env.REPO.getByName(b).approveTask(d))
			? Response.json({ task: d })
			: Response.json({ error: "that task isn't awaiting approval" }, { status: 409 });
	}
	if (request.method === "POST" && a === "repos" && b && c === "tasks" && d && (e === "take" || e === "retry")) {
		const repoDO = env.REPO.getByName(b);
		if (e === "retry") {
			return (await repoDO.retryTask(d)) ? Response.json({ task: d }) : Response.json({ error: "that task hasn't failed" }, { status: 409 });
		}
		const r = await repoDO.takeTask(d);
		return "error" in r ? Response.json(r, { status: 409 }) : Response.json(r, { status: 201 });
	}
	if (request.method === "POST" && a === "repos" && b && c === "memory" && !d) {
		const { text } = (await request.json()) as { text?: string };
		if (!text?.trim()) return Response.json({ error: "text required" }, { status: 400 });
		await env.REPO.getByName(b).addMemory([text.trim()], auth.user);
		return Response.json({ ok: true }, { status: 201 });
	}
	if (request.method === "DELETE" && a === "repos" && b && c === "memory" && d) {
		return (await env.REPO.getByName(b).deleteMemory(d))
			? Response.json({ ok: true })
			: Response.json({ error: "no such memory item" }, { status: 404 });
	}
	if (a === "repos" && b && c === "settings" && !d) {
		const repo = env.REPO.getByName(b);
		if (request.method === "GET") return Response.json(await repo.publicSettings());
		if (request.method !== "PUT") return Response.json({ error: "not found" }, { status: 404 });
		const r = await repo.setSettings(await request.json());
		return Response.json(r, { status: "error" in r ? 400 : 200 });
	}
	// A loose (pushed, unplaced) fork: ask for its placement, get a new push token, or review it.
	if (request.method === "POST" && a === "repos" && b && c === "forks" && d?.startsWith(`${b}-f-`) && (e === "place" || e === "token" || e === "review")) {
		const repo = env.REPO.getByName(b);
		let r: { error: string } | object;
		if (e === "review") {
			const { approve, comment } = (await request.json()) as { approve?: unknown; comment?: unknown };
			if (typeof approve !== "boolean") return Response.json({ error: "approve must be true or false" }, { status: 400 });
			r = await repo.review(d, approve, typeof comment === "string" ? comment.slice(0, 4000) : "");
		} else r = e === "place" ? await repo.requestPlacement(d) : await repo.pushToken(d);
		return "error" in r ? Response.json(r, { status: 409 }) : Response.json(r, { status: e === "token" ? 201 : 202 });
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
