<script lang="ts" module>
	export const PAGE = 20;
</script>

<script lang="ts">
	// Previous/next controls for a list. `more` overrides the total when the length isn't known (server paging).
	let { page = $bindable(0), total, more }: { page?: number; total?: number; more?: boolean } = $props();
	const last = $derived(total === undefined ? undefined : Math.max(0, Math.ceil(total / PAGE) - 1));
	const hasNext = $derived(more ?? page < (last ?? 0));
</script>

{#if page > 0 || hasNext}
	<nav class="pager" aria-label="Pagination">
		<button disabled={page <= 0} onclick={() => page--}>Previous</button>
		<span class="muted">Page {page + 1}{last !== undefined ? ` of ${last + 1}` : ""}</span>
		<button disabled={!hasNext} onclick={() => page++}>Next</button>
	</nav>
{/if}

<style>
	.pager { display: flex; align-items: center; justify-content: center; gap: 1rem; margin: 1rem 0; font-size: 0.875rem; }
</style>
