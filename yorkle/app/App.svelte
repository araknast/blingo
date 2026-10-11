<script lang="ts">
	import { match, navigate, route } from "./lib/router.svelte";
	import { loadMe, session } from "./lib/session.svelte";
	import Toasts from "./lib/Toasts.svelte";
	import Confirm from "./lib/Confirm.svelte";
	import Splash from "./routes/Splash.svelte";
	import Login from "./routes/Login.svelte";
	import Signup from "./routes/Signup.svelte";
	import Repos from "./routes/Repos.svelte";
	import RepoMap from "./routes/RepoMap.svelte";
	import BubbleCode from "./routes/BubbleCode.svelte";
	import Tasks from "./routes/Tasks.svelte";
	import Agents from "./routes/Agents.svelte";
	import Bubbles from "./routes/Bubbles.svelte";
	import Deploy from "./routes/Deploy.svelte";
	import Skills from "./routes/Skills.svelte";
	import Memory from "./routes/Memory.svelte";
	import Settings from "./routes/Settings.svelte";
	import LooseFork from "./routes/LooseFork.svelte";
	import NotFound from "./routes/NotFound.svelte";

	loadMe();

	const open = ["/", "/login", "/signup"];
	const path = $derived(route.path.replace(/\/+$/, "") || "/");

	// Signed-out visitors only see the open pages; signed-in ones skip them.
	$effect(() => {
		if (!session.checked) return;
		if (!session.me && !open.includes(path)) navigate("/login", true);
		else if (session.me && open.includes(path)) navigate("/repos", true);
	});

	const view = $derived.by((): { page: string; params: Record<string, string> } => {
		let m;
		if ((m = match("/repos/:repo/b/:bubble/*", path))) return { page: "bubble", params: m };
		if ((m = match("/repos/:repo/b/:bubble", path))) return { page: "bubble", params: { ...m, "*": "" } };
		if ((m = match("/repos/:repo/tasks/:id", path))) return { page: "tasks", params: m };
		if ((m = match("/repos/:repo/tasks", path))) return { page: "tasks", params: m };
		if ((m = match("/repos/:repo/agents/:id", path))) return { page: "agents", params: m };
		if ((m = match("/repos/:repo/agents", path))) return { page: "agents", params: m };
		if ((m = match("/repos/:repo/bubbles", path))) return { page: "bubbles", params: m };
		if ((m = match("/repos/:repo/deploy", path))) return { page: "deploy", params: m };
		if ((m = match("/repos/:repo/skills", path))) return { page: "skills", params: m };
		if ((m = match("/repos/:repo/memory", path))) return { page: "memory", params: m };
		if ((m = match("/repos/:repo/settings", path))) return { page: "settings", params: m };
		if ((m = match("/repos/:repo/forks/:fork", path))) return { page: "fork", params: m };
		if ((m = match("/repos/:repo", path))) return { page: "repo", params: m };
		if (path === "/repos") return { page: "repos", params: {} };
		return { page: path, params: {} };
	});
</script>

{#if session.checked}
	{#if !session.me}
		{#if path === "/login"}<Login />
		{:else if path === "/signup"}<Signup />
		{:else if path === "/"}<Splash />
		{/if}
	{:else if view.page === "repos"}<Repos />
	{:else if view.page === "repo"}{#key view.params.repo}<RepoMap repo={view.params.repo} />{/key}
	{:else if view.page === "agents"}{#key view.params.repo + "/" + view.params.id}<Agents repo={view.params.repo} id={view.params.id} />{/key}
	{:else if view.page === "bubbles"}{#key view.params.repo}<Bubbles repo={view.params.repo} />{/key}
	{:else if view.page === "deploy"}{#key view.params.repo}<Deploy repo={view.params.repo} />{/key}
	{:else if view.page === "skills"}{#key view.params.repo}<Skills repo={view.params.repo} />{/key}
	{:else if view.page === "memory"}{#key view.params.repo}<Memory repo={view.params.repo} />{/key}
	{:else if view.page === "settings"}{#key view.params.repo}<Settings repo={view.params.repo} />{/key}
	{:else if view.page === "fork"}{#key view.params.repo + "/" + view.params.fork}<LooseFork repo={view.params.repo} fork={view.params.fork} />{/key}
	{:else if view.page === "tasks"}{#key view.params.repo}<Tasks repo={view.params.repo} id={view.params.id} />{/key}
	{:else if view.page === "bubble"}
		{#key view.params.repo + "/" + view.params.bubble}
			<BubbleCode repo={view.params.repo} bubble={view.params.bubble} rest={view.params["*"]} />
		{/key}
	{:else if !open.includes(path)}<NotFound />
	{/if}
{/if}
<Toasts />
<Confirm />
