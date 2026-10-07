import { authRemote } from "./box";

export { Box, Outbound } from "./box";
export { RepoDO } from "./repo-do";

const id = () => crypto.randomUUID().slice(0, 8);

type Body = { prompt?: string; repo?: string; bubble?: string };

// Where a new fork comes from. No repo → brand-new repository (design: "a new repository is created").
async function source(env: Env, b: Body): Promise<{ repo: string; from: string } | Response> {
	if (!b.repo) {
		const repo = `r-${id()}`;
		await env.ARTIFACTS.create(repo, { setDefaultBranch: "main" });
		return { repo, from: repo };
	}
	const repoDO = env.REPO.getByName(b.repo);
	// No bubble named → any bubble; the base repo only while the repository has none.
	if (!b.bubble) return { repo: b.repo, from: (await repoDO.anyBubble()) ?? b.repo };
	const rep = await repoDO.repOf(b.bubble);
	return rep ? { repo: b.repo, from: rep } : Response.json({ error: "no such bubble" }, { status: 404 });
}

async function fork(env: Env, from: string, repo: string) {
	const name = `${repo}-f-${id()}`;
	using src = await env.ARTIFACTS.get(from);
	await src.fork(name, { defaultBranchOnly: true });
	return name;
}

export default {
	async fetch(request, env): Promise<Response> {
		// The API mints git tokens, so it is never open.
		if (request.headers.get("authorization") !== `Bearer ${env.BLINGO_TOKEN}`) {
			return Response.json({ error: "unauthorized" }, { status: 401 });
		}
		const url = new URL(request.url);
		const [, a, b, c] = url.pathname.split("/");

		if (request.method === "POST" && (a === "agents" || a === "notagents") && !b) {
			const body = (await request.json()) as Body;
			if (a === "agents" && !body.prompt) return Response.json({ error: "prompt required" }, { status: 400 });
			const src = await source(env, body);
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
				{ repo: src.repo, fork: name, remote, token: token.plaintext, push: `git push ${authed} HEAD:main` },
				{ status: 201 },
			);
		}

		if (request.method === "GET" && a === "agents" && b) return Response.json(await env.BOX.getByName(b).status());
		if (request.method === "GET" && a === "repos" && b && !c) return Response.json(await env.REPO.getByName(b).list());
		if (request.method === "DELETE" && a === "repos" && b && !c) {
			return Response.json({ deleted: await env.REPO.getByName(b).destroy(b) });
		}
		if (request.method === "GET" && a === "repos" && b && c && url.searchParams.has("path")) {
			const from = await env.REPO.getByName(b).readFrom(c);
			if (!from) return new Response("no such fork\n", { status: 404 });
			using repo = await env.ARTIFACTS.get(from);
			const file = await repo.readFile({ ref: "main", path: url.searchParams.get("path")! });
			return file === null
				? new Response("file not present\n", { status: 404 })
				: new Response(file, { headers: { "content-type": file.type || "application/octet-stream" } });
		}
		if (request.method === "GET" && a === "repos" && b && c) {
			const diff = await env.REPO.getByName(b).diff(c);
			return diff === null ? new Response("no diff\n", { status: 404 }) : new Response(diff);
		}
		return Response.json({ error: "not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
