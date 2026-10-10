<script lang="ts">
	// Issue-tracker status mark: awaiting approval (dashed), open ○, in progress (pulsing), completed ✓, failed ✕.
	import type { TaskStatus } from "./types";

	let { status }: { status: TaskStatus } = $props();
	const label = $derived({ "awaiting-approval": "Awaiting approval", open: "Open", "in-progress": "In progress", completed: "Completed", failed: "Failed" }[status]);
</script>

<span class="icon {status}" class:pulse={status === "in-progress"} role="img" aria-label={label} title={label}>
	{status === "completed" ? "✓" : status === "failed" ? "✕" : ""}
</span>

<style>
	.icon {
		display: inline-grid;
		place-items: center;
		width: 1rem;
		height: 1rem;
		border-radius: 50%;
		flex: none;
		font-size: 0.625rem;
		font-weight: 700;
		color: #fff;
		line-height: 1;
	}
	.open { box-shadow: inset 0 0 0 2px var(--merged); }
	.awaiting-approval { border: 2px dashed var(--ink-3); }
	.in-progress { background: var(--working); }
	.completed { background: var(--merged); }
	.failed { background: var(--conflict); }
</style>
