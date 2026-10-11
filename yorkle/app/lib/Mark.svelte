<script lang="ts">
	// A state's mark (Glyph) as an inline icon. With `label` it's an image screen readers announce.
	import Glyph from "./Glyph.svelte";

	let { status, label }: { status: string; label?: string } = $props();
</script>

<svg class="mark" width="14" height="14" viewBox="-7 -7 14 14" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
	{#if label}<title>{label}</title>{/if}
	<Glyph {status} />
</svg>
