<svelte:options namespace="svg" />

<script lang="ts">
	// A state's mark, centred on 0,0 (about 14 units across). Shape as well as colour tells states apart:
	// a ring is waiting, a filled dot is done, an ✕ is failed, a diamond is a conflict. Styles: style.css.
	let { status }: { status: string } = $props();
</script>

{#if status === "rep"}
	<circle class="g-rep" r="6.5" />
{:else if status === "pending"}
	<circle class="g-pending" r="5" />
{:else if status === "merged"}
	<circle class="g-merged" r="5" />
{:else if status === "conflict"}
	<rect class="g-conflict" x="-4.2" y="-4.2" width="8.4" height="8.4" rx="1" transform="rotate(45)" />
{:else if status === "failed"}
	<circle class="g-failed" r="5.5" /><path class="g-failed-x" d="M -2.4 -2.4 L 2.4 2.4 M 2.4 -2.4 L -2.4 2.4" />
{:else if status === "running"}
	<circle class="g-running" r="4.5" />
{:else if status === "ferging"}
	<circle class="g-ferging" r="4.5" />
{:else if status === "placing" || status === "loose"}
	<circle class="g-placing" r="4.5" />
{:else if status === "approval"}
	<circle class="g-approval" r="5" />
{:else if status === "review"}
	<circle class="g-review" r="5" /><circle class="g-review-dot" r="1.8" />
{:else}
	<circle class="g-waiting" r="4.5" />
{/if}
