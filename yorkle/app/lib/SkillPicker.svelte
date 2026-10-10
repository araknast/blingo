<script lang="ts">
	// Which of the repository's skills an agent loads. `chosen` stays undefined while all are ticked
	// (the default: the API then gives the agent every skill, including ones added later).
	import type { Skill } from "./types";

	let { skills, chosen = $bindable(undefined) }: { skills: Skill[]; chosen?: string[] } = $props();
	const on = (name: string) => (chosen ?? skills.map((s) => s.name)).includes(name);
	function toggle(name: string) {
		const now = (chosen ?? skills.map((s) => s.name)).filter((n) => n !== name);
		if (!on(name)) now.push(name);
		chosen = now.length === skills.length ? undefined : now;
	}
</script>

{#if skills.length}
	<fieldset class="field">
		<legend>Skills</legend>
		{#each skills as s (s.name)}
			<label class="choice"><input type="checkbox" checked={on(s.name)} onchange={() => toggle(s.name)} /> <span class="mono">{s.name}</span> <span class="muted">{s.description}</span></label>
		{/each}
		<p class="hint">Only the ticked skills are loaded into the agent's context.</p>
	</fieldset>
{/if}

<style>
	fieldset { border: 0; padding: 0; margin: 0 0 1rem; min-width: 0; }
	legend { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.3rem; padding: 0; }
	.choice { display: flex; gap: 0.5rem; align-items: baseline; font-weight: 400; margin: 0.2rem 0; }
	.choice input { width: auto; }
</style>
