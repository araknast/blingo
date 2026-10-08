<script lang="ts">
	import type { Snippet } from "svelte";

	let { open = $bindable(false), title, wide = false, children }: { open: boolean; title: string; wide?: boolean; children: Snippet } =
		$props();
	let el: HTMLDialogElement;

	$effect(() => {
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});
</script>

<!-- Native modal: focus trap, Escape and backdrop come from the browser. -->
<dialog bind:this={el} class:wide onclose={() => (open = false)} onclick={(e) => e.target === el && (open = false)}>
	<div class="body">
		<header>
			<h2>{title}</h2>
			<button class="quiet" aria-label="Close" onclick={() => (open = false)}>✕</button>
		</header>
		{#if open}{@render children()}{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(32rem, calc(100vw - 2rem));
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		background: var(--paper);
		color: var(--ink);
		box-shadow: 0 24px 64px rgb(15 24 33 / 0.3);
	}
	dialog.wide { width: min(44rem, calc(100vw - 2rem)); }
	dialog::backdrop { background: rgb(15 24 33 / 0.45); }
	dialog[open] { animation: rise 160ms ease-out; }
	@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
	.body { padding: 1.25rem 1.5rem 1.5rem; }
	header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
	header button { padding: 0.25rem 0.5rem; }
</style>
