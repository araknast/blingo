<script lang="ts">
	// The repository's deployments: every run and its status, and a button to start one on a bubble.
	import Dialog from "../lib/Dialog.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import { ago, duration, repoName, short } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 3000);
	const runs = $derived(rd.data?.deploys ?? []);
	const configs = $derived(rd.data?.settings.deploys ?? []);
	const bubbles = $derived(rd.data?.bubbles ?? []);
	let page = $state(0);
	const shown = $derived(runs.slice(Math.min(page, Math.max(0, Math.ceil(runs.length / PAGE) - 1)) * PAGE).slice(0, PAGE));
	const bubbleName = (id: string) => bubbles.find((b) => b.id === id)?.name || short(id);

	let open = $state(false);
	let name = $state("");
	let bubble = $state("");
	let busy = $state(false);
	async function start(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", `/repos/${repo}/deploys`, { name, bubble });
			open = false;
			toast("Deployment started");
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	const label = { running: "Running", succeeded: "Succeeded", failed: "Failed" } as const;
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Deploy" }]}
	{repo}
	openTasks={rd.data?.tasks.filter((t) => t.status !== "completed").length}
	activeAgents={rd.data?.agents.filter((a) => a.status === "running").length}
	runningDeploys={rd.data?.deploys.filter((d) => d.status === "running").length}
>
	<div class="page">
		<h1>Deploy</h1>
		<p class="muted lede">A deployment runs its command in a fresh sandbox on a bubble's current code. Start one by hand; set them up in <a href="/repos/{repo}/settings">settings</a>.</p>
		<button
			class="primary"
			disabled={!configs.length || !bubbles.length}
			onclick={() => {
				name = configs[0]?.name ?? "";
				bubble = bubbles.find((b) => b.visible)?.id ?? "";
				open = true;
			}}>Deploy…</button
		>
		{#if rd.data && !configs.length}<p class="muted">No deployments are configured yet.</p>{/if}
		{#if rd.data && configs.length && !runs.length}
			<p class="muted">Nothing deployed yet.</p>
		{:else if runs.length}
			<ul class="runs">
				{#each shown as d (d.id)}
					<li>
						<details>
							<summary>
								<span class="status {d.status}">{label[d.status]}</span>
								<span class="mono">{d.name}</span>
								<span class="muted">on {bubbleName(d.bubble)} at <span class="mono">{d.head.slice(0, 7) || "…"}</span></span>
								<span class="muted small">{d.by}, {ago(d.started)}{d.finished ? `, took ${duration(d.finished - d.started)}` : ""}</span>
							</summary>
							<pre>{d.log || (d.status === "running" ? "Running…" : "(no output)")}</pre>
						</details>
					</li>
				{/each}
			</ul>
			<Pager bind:page total={runs.length} />
		{/if}
	</div>
</Shell>

<Dialog bind:open title="Deploy">
	<form onsubmit={start}>
		<div class="field">
			<label for="dep-name">Deployment</label>
			<select id="dep-name" bind:value={name}>
				{#each configs as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
			</select>
		</div>
		<div class="field">
			<label for="dep-bubble">Bubble</label>
			<select id="dep-bubble" bind:value={bubble}>
				{#each bubbles as b (b.id)}<option value={b.id}>{b.name || short(b.id)}</option>{/each}
			</select>
			<p class="hint">Deploys the bubble's code as it is now. A bubble with changes still queued has to wait.</p>
		</div>
		<button class="primary" disabled={busy}>Deploy</button>
	</form>
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 60rem; }
	.lede { margin: 0.4rem 0 1.25rem; }
	.runs { list-style: none; margin: 1.25rem 0 0; padding: 0; display: grid; gap: 0.5rem; }
	.runs li { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	summary { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: baseline; padding: 0.75rem 1rem; cursor: pointer; }
	pre { margin: 0; padding: 0.75rem 1rem; border-top: 1px solid var(--line); overflow-x: auto; font-size: 0.8125rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	.status { font-weight: 600; }
	.status.failed { color: var(--conflict); }
	.status.succeeded { color: var(--merged); }
	.small { font-size: 0.8125rem; }
</style>
