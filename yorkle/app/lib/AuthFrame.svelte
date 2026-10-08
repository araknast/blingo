<script lang="ts">
	import type { Snippet } from "svelte";

	let { title, children, footer }: { title: string; children: Snippet; footer?: Snippet } = $props();
</script>

<div class="frame">
	<a class="wordmark" href="/">yorkle</a>
	<div class="panel">
		<h1>{title}</h1>
		{@render children()}
	</div>
	{#if footer}<p class="footer">{@render footer()}</p>{/if}
</div>

<style>
	.frame {
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		padding: 2rem clamp(1rem, 8vw, 7rem);
		background:
			radial-gradient(circle at 1px 1px, var(--line) 1px, transparent 0) 0 0 / 24px 24px,
			var(--fog);
	}
	.wordmark { font-weight: 700; font-size: 1.75rem; letter-spacing: -0.045em; text-decoration: none; margin-bottom: clamp(2rem, 10vh, 6rem); }
	.panel {
		width: min(26rem, 100%);
		padding: 1.75rem;
		background: var(--paper);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
	}
	h1 { margin-bottom: 1.5rem; }
	.footer { margin-top: 1.25rem; font-size: 0.9375rem; color: var(--ink-2); }
</style>
