<script lang="ts">
	import { onDestroy } from "svelte";
	import Shell from "../lib/Shell.svelte";
	import { ApiError, api, session } from "../lib/session.svelte";
	import type { RepoState } from "../lib/types";
	import { copy, poll, repoName, short } from "../lib/util";
	import Dialog from "../lib/Dialog.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
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

	// A read-only clone command, fetched when asked for: it holds a token good for an hour.
	let cloneCmd = $state("");
	let cloneOpen = $state(false);
	async function clone() {
		try {
			const { url } = await api<{ url: string }>("GET", `/repos/${repo}/${bubble}/clone`);
			const dir = (b?.name || short(bubble)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bubble";
			cloneCmd = `git clone ${url} ${dir}`;
			cloneOpen = true;
		} catch (e) {
			toastError(e);
		}
	}
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
		<div class="page">
			<BubbleView {repo} {bubble} {rest} {base} {data} {refresh}>
				{#snippet actions()}<button onclick={clone}>Clone</button>{/snippet}
			</BubbleView>
		</div>
	{/if}
</Shell>

<Dialog bind:open={cloneOpen} title="Clone {b?.name || short(bubble)}">
	<div class="cmd">
		<pre>{cloneCmd}</pre>
		<button onclick={() => copy(cloneCmd).then(() => toast("Clone command copied"))}>Copy</button>
	</div>
	<p class="hint">Read-only, and good for an hour. To change the code, take a task or push a fork.</p>
</Dialog>

<style>
	.cmd { display: flex; gap: 0.5rem; align-items: flex-start; margin-bottom: 0.75rem; }
	.cmd pre { flex: 1; margin: 0; padding: 0.7rem 0.8rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); white-space: pre-wrap; word-break: break-all; }
	.page { padding: 1.75rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 80rem; }
</style>
