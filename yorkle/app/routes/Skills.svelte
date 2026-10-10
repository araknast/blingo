<script lang="ts">
	// The repository's skills: Claude Code skill folders that agents can load.
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import { ago, repoName } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 5000);
	const items = $derived(rd.data?.skills ?? []);
	let page = $state(0);
	const shown = $derived(items.slice(Math.min(page, Math.max(0, Math.ceil(items.length / PAGE) - 1)) * PAGE).slice(0, PAGE));

	let busy = $state(false);
	const b64 = async (f: File) => {
		let bin = "";
		for (const b of new Uint8Array(await f.arrayBuffer())) bin += String.fromCharCode(b);
		return btoa(bin);
	};
	// The folder picker gives every file with its path from the picked folder ("skill/SKILL.md").
	async function upload(e: Event & { currentTarget: HTMLInputElement }) {
		const picked = [...(e.currentTarget.files ?? [])];
		e.currentTarget.value = "";
		if (!picked.length) return;
		busy = true;
		try {
			const files = await Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, data: await b64(f) })));
			const r = await api<{ name: string }>("POST", `/repos/${repo}/skills`, { files });
			toast(`Skill ${r.name} added`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	async function remove(name: string) {
		if (!confirm(`Remove the skill ${name}? Tasks that named it lose it.`)) return;
		try {
			await api("DELETE", `/repos/${repo}/skills/${name}`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		}
	}
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Skills" }]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
	activeAgents={rd.data?.agents.filter((a) => a.status === "running").length}
>
	<div class="page">
		<h1>Skills</h1>
		<p class="muted lede">Claude Code skills for this repository. A new agent loads all of them unless whoever starts it picks some. Upload a skill folder (it needs a <span class="mono">SKILL.md</span> with a name and description).</p>
		<label class="upload primary"
			>{busy ? "Uploading…" : "Upload skill folder"}
			<input type="file" webkitdirectory multiple hidden disabled={busy} onchange={upload} />
		</label>
		{#if rd.data && !items.length}
			<p class="muted">No skills yet.</p>
		{:else}
			<ul class="skills">
				{#each shown as s (s.name)}
					<li>
						<p><span class="mono">{s.name}</span></p>
						<p class="muted">{s.description}</p>
						<span class="muted small">added {ago(s.created)}</span>
						<button class="quiet" aria-label="Remove {s.name}" onclick={() => remove(s.name)}>Remove</button>
					</li>
				{/each}
			</ul>
			<Pager bind:page total={items.length} />
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 52rem; }
	.lede { margin: 0.4rem 0 1.25rem; }
	.upload { display: inline-block; margin-bottom: 1.5rem; cursor: pointer; padding: 0.5rem 0.9rem; border-radius: var(--r-md); }
	.skills { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.skills li { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	.skills p { overflow-wrap: anywhere; }
	.skills button { grid-row: 1 / span 3; grid-column: 2; align-self: center; }
	.small { font-size: 0.8125rem; }
</style>
