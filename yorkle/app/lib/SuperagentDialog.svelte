<script lang="ts">
	// Start a superagent: it reads a bubble's code and plans the request into tasks.
	import Dialog from "./Dialog.svelte";
	import ModelField from "./ModelField.svelte";
	import { api } from "./session.svelte";
	import { toast, toastError } from "./toast.svelte";
	import type { Bubble } from "./types";
	import { short } from "./util";

	let {
		open = $bindable(false),
		repo,
		bubbles,
		fixedBase = null,
		onstarted,
	}: { open: boolean; repo: string; bubbles: Bubble[]; fixedBase?: string | null; onstarted?: () => void } = $props();

	let prompt = $state("");
	let base = $state("");
	let model = $state("");
	let busy = $state(false);
	$effect(() => {
		if (open) base = fixedBase ?? "";
	});

	async function start(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", "/superagents", { repo, prompt, bubble: base || undefined, model: model.trim() || undefined });
			open = false;
			prompt = "";
			toast("Superagent started. Its tasks appear on the Tasks tab when it finishes planning.");
			onstarted?.();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title="Plan tasks with a superagent">
	<form onsubmit={start}>
		<div class="field">
			<label for="super-prompt">What should get done?</label>
			<textarea id="super-prompt" bind:value={prompt} required placeholder="Add user accounts: signup, login and a profile page"></textarea>
		</div>
		<div class="field">
			{#if fixedBase}
				<p class="from">Reads bubble <span class="mono">{short(fixedBase)}</span></p>
			{:else}
				<label for="super-base">Start from</label>
				<select id="super-base" bind:value={base}>
					<option value="">Any bubble</option>
					{#each bubbles as b (b.id)}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
				</select>
			{/if}
			<p class="hint">The superagent reads this code and splits the work into tasks, for agents or for you. Each task starts once the tasks it depends on have landed.</p>
		</div>
		<div class="field"><ModelField id="super-model" bind:value={model} /></div>
		<button class="primary" disabled={busy}>Plan tasks</button>
	</form>
</Dialog>

<style>
	.from { font-size: 0.875rem; color: var(--ink-2); }
	.from .mono { color: var(--ink); }
</style>
