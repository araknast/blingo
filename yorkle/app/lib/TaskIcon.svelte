<script lang="ts">
	// A task's status mark, in the map's shapes: awaiting approval (dashed ring), open (ring), in progress
	// (pulsing dot), completed (filled dot), failed (✕).
	import Mark from "./Mark.svelte";
	import type { TaskStatus } from "./types";

	let { status }: { status: TaskStatus } = $props();
	const label = $derived({ "awaiting-approval": "Awaiting approval", open: "Open", "in-progress": "In progress", completed: "Completed", failed: "Failed" }[status]);
	const glyph = $derived({ "awaiting-approval": "approval", open: "pending", "in-progress": "running", completed: "merged", failed: "failed" }[status]);
</script>

<span class="icon"><Mark status={glyph} {label} /></span>

<style>
	.icon { display: inline-flex; flex: none; }
</style>
