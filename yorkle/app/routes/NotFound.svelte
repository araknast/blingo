<script lang="ts">
	import Shell from "../lib/Shell.svelte";
</script>

<Shell crumbs={[{ label: "Not found" }]}>
	<div class="page">
		<h1>There's nothing at this address</h1>
		<p>The page may have moved, or the link is wrong. <a href="/repos">Go to your repositories</a>.</p>
	</div>
</Shell>

<style>
	.page { padding: 2rem clamp(1rem, 3vw, 2.5rem); }
	p { margin-top: 0.75rem; color: var(--ink-2); }
</style>
