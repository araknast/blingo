<script lang="ts">
	// A deployment's log. While it runs, poll its sandbox for output as it appears (like an agent's
	// transcript on the Agents page), following the tail unless the reader has scrolled up; once it has
	// finished, show the stored log the repository state carries.
	import { tick as nextTick } from "svelte";
	import { atFailure } from "./atFailure";
	import { api } from "./session.svelte";
	import { poll } from "./util";

	let { repo, id, running, stored }: { repo: string; id: string; running: boolean; stored: string | null } = $props();

	let live = $state(""); // output seen so far while it runs
	let loaded = $state(false);
	let error = $state("");
	let cursor = 0; // the lines already read, for the next poll
	let stop = () => {};
	// Poll only while it runs; when it ends, the parent's stored log takes over.
	$effect(() => {
		if (!running) return;
		stop = poll(async () => {
			try {
				const r = await api<{ status: string; log: string; next: number }>("GET", `/repos/${repo}/deploys/${id}/log?from=${cursor}`);
				// Read output only while the job is still running: the finished job's stored log is a tail
				// the parent already shows, and appending it here would double what's on screen.
				if (r.status === "running" && r.log) {
					live = live ? `${live}\n${r.log}` : r.log;
					cursor = r.next;
				}
				loaded = true;
				error = "";
			} catch (e) {
				error = String((e as Error).message ?? e);
				loaded = true;
			}
		}, 1500);
		return () => stop();
	});

	// Follow new output unless the reader has scrolled up.
	let el = $state<HTMLElement>();
	let pinned = $state(true);
	const onscroll = () => (pinned = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	$effect(() => {
		live.length;
		if (running && pinned) nextTick().then(() => el?.scrollTo({ top: el.scrollHeight }));
	});

	const text = $derived(running ? (loaded ? live : "") : (stored ?? ""));
</script>

{#if running && error && !live}
	<p class="muted pad">Its log couldn't be loaded: {error}</p>
{:else}
	<pre bind:this={el} {onscroll} use:atFailure>{text || (running ? "Running…" : "(no output)")}</pre>
{/if}

<style>
	pre { margin: 0; padding: 0.75rem 1rem; border-top: 1px solid var(--line); max-height: 24rem; overflow: auto; font-size: 0.8125rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--paper); }
	.pad { margin: 0; padding: 0.75rem 1rem; border-top: 1px solid var(--line); font-size: 0.8125rem; }
</style>
