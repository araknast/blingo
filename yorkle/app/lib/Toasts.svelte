<script lang="ts">
	import { fly } from "svelte/transition";
	import { dismiss, toasts } from "./toast.svelte";
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each toasts as t (t.id)}
		<div class="toast" class:error={t.error} transition:fly={{ y: 12, duration: 180 }}>
			<span>{t.text}</span>
			{#if t.action}<button class="act" onclick={() => (t.action!.run(), dismiss(t.id))}>{t.action.label}</button>{/if}
			<button class="quiet" aria-label="Dismiss" onclick={() => dismiss(t.id)}>✕</button>
		</div>
	{/each}
</div>

<style>
	.toasts {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		display: grid;
		gap: 0.5rem;
		z-index: 100;
		max-width: min(26rem, calc(100vw - 2rem));
	}
	.toast {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.6rem 0.4rem 0.6rem 1rem;
		background: var(--harbor);
		color: #fff;
		border-radius: var(--r-md);
		font-size: 0.875rem;
		box-shadow: 0 6px 24px rgb(15 24 33 / 0.25);
	}
	.toast span { flex: 1; overflow-wrap: anywhere; }
	.toast.error { box-shadow: inset 0 0 0 1px var(--conflict), 0 6px 24px rgb(15 24 33 / 0.25); }
	.toast .act { border: 1px solid rgb(255 255 255 / 0.35); font-weight: 600; }
	.toast button { color: inherit; padding: 0.2rem 0.5rem; }
	.toast button:hover { background: rgb(255 255 255 / 0.12); }
</style>
