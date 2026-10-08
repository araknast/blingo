<script lang="ts">
	// Clone and push commands for a notagent fork (a pushed fork or a taken human task).
	import { toast } from "./toast.svelte";
	import { copy, short } from "./util";

	let { pushed }: { pushed: { fork: string; clone: string; push: string } } = $props();
</script>

<p class="intro">Fork <span class="mono">{short(pushed.fork)}</span> is ready. Push to it within the hour.</p>
<ol class="steps">
	<li>
		<p>Clone the fork</p>
		{@render cmd(pushed.clone, "Clone command copied")}
	</li>
	<li>
		<p>Commit your changes, then push</p>
		{@render cmd(pushed.push, "Push command copied")}
	</li>
</ol>
<p class="hint">These commands hold a write token for this fork only. Only your first push counts.</p>

{#snippet cmd(text: string, done: string)}
	<div class="cmd">
		<pre>{text}</pre>
		<button onclick={() => copy(text).then(() => toast(done))}>Copy</button>
	</div>
{/snippet}

<style>
	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	.intro .mono { color: var(--ink); }
	.steps { margin: 0 0 1rem; padding-left: 1.25rem; display: grid; gap: 1rem; }
	.steps p { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.4rem; }
	.cmd { display: flex; gap: 0.5rem; align-items: flex-start; }
	.cmd pre { flex: 1; margin: 0; padding: 0.7rem 0.8rem; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-sm); white-space: pre-wrap; word-break: break-all; }
</style>
