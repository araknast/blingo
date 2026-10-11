<script lang="ts">
	import { onDestroy } from "svelte";
	import Shell from "../lib/Shell.svelte";
	import { ApiError, api, session } from "../lib/session.svelte";
	import type { RepoState } from "../lib/types";
	import { poll, repoName, short } from "../lib/util";
	import BubbleView from "../lib/BubbleView.svelte";

	let { repo, bubble, rest }: { repo: string; bubble: string; rest: string } = $props();

	let data = $state<RepoState | null>(null);
	let missingRepo = $state(false);
	async function refresh() {
		try {
			data = await api<RepoState>("GET", `/repos/${repo}`);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) missingRepo = true;
		}
	}
	const stop = poll(refresh, 5000);
	onDestroy(stop);

	const b = $derived(data?.bubbles.find((x) => x.id === bubble));
	const loose = $derived(!!data?.loose.some((l) => l.fork === bubble));
	const base = $derived(`/repos/${repo}/b/${bubble}`);
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repoName(repo, session.me?.names), href: `/repos/${repo}` },
		{ label: "Bubbles", href: `/repos/${repo}/bubbles` },
		{ label: b?.name || `${loose ? "Fork" : "Bubble"} ${short(bubble)}`, href: base },
	]}
	{repo}
	{data}
>
	{#if missingRepo}
		<div class="page"><h1>This repository isn't available</h1><p class="muted">It doesn't exist, or it belongs to someone else.</p></div>
	{:else}
		<div class="page"><BubbleView {repo} {bubble} {rest} {base} {data} {refresh} /></div>
	{/if}
</Shell>

<style>
	.page { padding: 1.75rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 80rem; }
</style>
