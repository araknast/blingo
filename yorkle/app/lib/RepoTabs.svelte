<script lang="ts">
	// The repository's top-level views.
	let { repo, current, open }: { repo: string; current: "map" | "tasks"; open?: number } = $props();
</script>

<nav class="tabs repo-tabs" aria-label="Repository">
	<a href="/repos/{repo}" aria-current={current === "map" ? "page" : undefined}>Map</a>
	<a href="/repos/{repo}/tasks" aria-current={current === "tasks" ? "page" : undefined}>
		Tasks{#if open}<span class="n">{open}</span>{/if}
	</a>
</nav>

<style>
	.repo-tabs { margin: 0; padding: 0 clamp(1rem, 3vw, 2.5rem); background: var(--paper); flex: none; }
</style>
