<script lang="ts">
	// A fork that isn't in a bubble yet, on its own page (the map opens the same view in a drawer).
	import ForkDetail from "../lib/ForkDetail.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { session } from "../lib/session.svelte";
	import { repoName, short } from "../lib/util";

	let { repo, fork }: { repo: string; fork: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 3000);
	const task = $derived(rd.data?.tasks.find((t) => t.fork === fork));
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		{ label: "Agents", href: `/repos/${repo}/agents` },
		{ label: task?.title ?? rd.data?.agents.find((a) => a.fork === fork)?.prompt ?? `Fork ${short(fork)}` },
	]}
	{repo}
	data={rd.data}
>
	<div class="page">
		<ForkDetail {repo} {fork} data={rd.data} refresh={rd.refresh} />
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 56rem; }
</style>
