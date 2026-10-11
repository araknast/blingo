<script lang="ts">
	import Dialog from "./Dialog.svelte";
	import { asking } from "./confirm.svelte";

	let open = $state(false);
	$effect(() => {
		open = !!asking.q;
	});
	// Closing the dialog any other way (Escape, the backdrop, ✕) is a no.
	$effect(() => {
		if (!open && asking.q) asking.answer(false);
	});
</script>

<Dialog bind:open title={asking.q?.title ?? ""}>
	{#if asking.q}
		<p class="body">{asking.q.body}</p>
		<div class="row">
			<button class="primary" class:danger-fill={asking.q.danger} onclick={() => asking.answer(true)}>{asking.q.confirm}</button>
			<button onclick={() => asking.answer(false)}>Cancel</button>
		</div>
	{/if}
</Dialog>

<style>
	.body { color: var(--ink-2); margin-bottom: 1.25rem; }
	.row { display: flex; gap: 0.5rem; }
</style>
