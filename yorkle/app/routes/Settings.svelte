<script lang="ts">
	// Repository settings (PUT /repos/:r/settings), and deleting the repository.
	import Dialog from "../lib/Dialog.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { navigate } from "../lib/router.svelte";
	import { api, loadMe, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { Settings } from "../lib/types";
	import { repoName } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 15000);

	// The form's copy, taken once the settings arrive (polls don't overwrite edits in progress).
	let form = $state<(Omit<Settings, "ci"> & { ci: Settings["ci"] & { hostsText: string } }) | null>(null);
	$effect(() => {
		const s = rd.data?.settings;
		if (s && !form) form = { ...$state.snapshot(s), ci: { ...$state.snapshot(s.ci), hostsText: s.ci.hosts.join(", ") } };
	});
	let apiKey = $state("");
	let busy = $state(false);

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!form) return;
		busy = true;
		try {
			const { ci, hasKey: _, ...rest } = form;
			const hosts = ci.hostsText.split(/[\s,]+/).filter(Boolean);
			await api("PUT", `/repos/${repo}/settings`, { ...rest, ci: { enabled: ci.enabled, command: ci.command, hosts }, ...(apiKey ? { apiKey } : {}) });
			apiKey = "";
			form = null; // take the saved values
			await rd.refresh();
			toast("Settings saved");
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	async function removeKey() {
		try {
			await api("PUT", `/repos/${repo}/settings`, { apiKey: "" });
			form = null;
			await rd.refresh();
			toast("API key removed");
		} catch (err) {
			toastError(err);
		}
	}

	let deleteOpen = $state(false);
	let confirmName = $state("");
	async function destroy(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("DELETE", `/repos/${repo}`);
			await loadMe();
			toast(`Deleted ${repoName(repo, session.me?.names)}`);
			navigate("/repos");
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Settings" }]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
>
	<div class="page">
		<h1>Settings</h1>
		{#if !form}
			<p class="muted">Loading…</p>
		{:else}
			<form onsubmit={save}>
				<section>
					<h2>Placing forks</h2>
					<label class="check"><input type="checkbox" bind:checked={form.autoPlaceNotagents} /> Place human forks as soon as they're pushed (and pass CI)</label>
					<p class="hint">Off: pushed forks wait on the map until someone places them.</p>
				</section>

				<section>
					<h2>CI</h2>
					<label class="check"><input type="checkbox" bind:checked={form.ci.enabled} /> Run CI on every push before a fork is placed</label>
					<div class="field">
						<label for="ci-command">Command</label>
						<input id="ci-command" class="mono" bind:value={form.ci.command} placeholder="npm ci && npm test" />
						<p class="hint">Runs in a fresh sandbox on the pushed commit. Leave it empty to only review.</p>
					</div>
					<div class="field">
						<label for="ci-hosts">Hosts CI may reach</label>
						<input id="ci-hosts" class="mono" bind:value={form.ci.hostsText} placeholder="registry.npmjs.org" />
						<p class="hint">Besides the git server. Separate them with commas. CI never gets an API key.</p>
					</div>
					<div class="field">
						<label for="review">Review</label>
						<select id="review" bind:value={form.review}>
							<option value="none">None</option>
							<option value="auto">Automatic (an agent reviews it)</option>
							<option value="manual">Manual (someone approves it)</option>
							<option value="both">Both</option>
						</select>
					</div>
					<div class="field">
						<label for="pushes">Pushes an agent gets to pass CI</label>
						<input id="pushes" type="number" min="1" max="20" bind:value={form.maxAgentPushes} />
						<p class="hint">Each failure starts an agent to fix it. After the last, a person takes over the fork.</p>
					</div>
				</section>

				<section>
					<h2>Models</h2>
					<div class="field">
						<label for="provider">API</label>
						<select id="provider" bind:value={form.provider}>
							<option value="anthropic">Anthropic</option>
							<option value="openrouter">OpenRouter</option>
						</select>
					</div>
					<div class="field">
						<label for="api-key">API key</label>
						<div class="row">
							<input id="api-key" type="password" autocomplete="off" bind:value={apiKey} placeholder={form.hasKey ? "A key is set. Type a new one to replace it" : "Uses blingo's own key when empty"} />
							{#if form.hasKey}<button type="button" onclick={removeKey}>Remove</button>{/if}
						</div>
						<p class="hint">Stored for this repository only, never shown again, and never given to a sandbox.</p>
					</div>
					{#each [["agent", "Agents"], ["superagent", "Superagents"], ["ferge", "Ferge agents"]] as [role, label] (role)}
						<div class="field">
							<label for="model-{role}">{label}</label>
							<input id="model-{role}" class="mono" bind:value={form.models[role as "agent"]} placeholder="Default model" />
						</div>
					{/each}
				</section>

				<section>
					<h2>Agents and tasks</h2>
					<label class="check"><input type="checkbox" bind:checked={form.fergeAgents} /> After a ferge, start an agent to resolve its conflicts</label>
					<label class="check"><input type="checkbox" bind:checked={form.taskApproval} /> New tasks wait for approval before they start</label>
				</section>

				<button class="primary" disabled={busy}>Save settings</button>
			</form>
		{/if}

		<section class="danger-zone">
			<h2>Delete repository</h2>
			<p class="muted">Deletes every bubble, fork and record in it. It can't be undone.</p>
			<button class="delete" onclick={() => (deleteOpen = true)}>Delete repository</button>
		</section>
	</div>
</Shell>

<Dialog bind:open={deleteOpen} title="Delete this repository?">
	<form onsubmit={destroy}>
		<p class="intro">This deletes every bubble, fork and agent record in <strong>{repoName(repo, session.me?.names)}</strong>. It can't be undone.</p>
		<div class="field">
			<label for="confirm">Type <span class="mono">{repo}</span> to confirm</label>
			<input id="confirm" autocomplete="off" bind:value={confirmName} />
		</div>
		<button class="primary delete" disabled={busy || confirmName !== repo}>Delete repository</button>
	</form>
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 44rem; }
	h1 { margin-bottom: 1rem; }
	section { padding: 1.1rem 0 0.4rem; border-top: 1px solid var(--line-2); }
	h2 { font-size: 1rem; margin-bottom: 0.75rem; }
	.check { display: flex; gap: 0.5rem; align-items: center; font-weight: 400; margin-bottom: 0.4rem; }
	.check input { width: auto; }
	.check + .hint { margin: -0.2rem 0 0.75rem 1.6rem; }
	.row { display: flex; gap: 0.5rem; }
	.row input { flex: 1; min-width: 0; }
	form > button { margin-top: 1rem; }
	.danger-zone { margin-top: 2.5rem; }
	.danger-zone p { margin-bottom: 0.75rem; }
	.delete { color: var(--conflict); }
	.primary.delete { background: var(--conflict); border-color: var(--conflict); color: #fff; }
	.intro { margin-bottom: 1rem; color: var(--ink-2); }
</style>
