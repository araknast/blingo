<script lang="ts">
	// The repository's deployments: every run and its status, and starting one on a bubble. `?bubble=`
	// (from the map's menu) picks the bubble.
	import { atFailure } from "../lib/atFailure";
	import Dialog from "../lib/Dialog.svelte";
	import Mark from "../lib/Mark.svelte";
	import Pager, { PAGE } from "../lib/Pager.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { route } from "../lib/router.svelte";
	import { api, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { Bubble } from "../lib/types";
	import { ago, duration, repoName, runId, short } from "../lib/util";

	let { repo }: { repo: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repoState(repo, 3000);
	const runs = $derived(rd.data?.deploys ?? []);
	const configs = $derived(rd.data?.settings.deploys ?? []);
	const bubbles = $derived(rd.data?.bubbles ?? []);
	let page = $state(0);
	const shown = $derived(runs.slice(Math.min(page, Math.max(0, Math.ceil(runs.length / PAGE) - 1)) * PAGE).slice(0, PAGE));
	const bubbleName = (id: string) => bubbles.find((b) => b.id === id)?.name || short(id);
	// Why a bubble can't be deployed right now (the server refuses these), or null.
	const blocked = (b: Bubble) =>
		!b.visible ? "merging" : b.locked ? "locked" : b.members.some((m) => m.status === "pending") ? "changes still queued" : null;

	let open = $state(false);
	let name = $state("");
	let bubble = $state("");
	let busy = $state(false);
	const config = $derived(configs.find((c) => c.name === name));
	function openDeploy(n?: string, b?: string) {
		name = n ?? configs[0]?.name ?? "";
		const wanted = b ?? new URLSearchParams(route.search).get("bubble") ?? "";
		bubble = bubbles.find((x) => x.id === wanted && !blocked(x))?.id ?? bubbles.find((x) => !blocked(x))?.id ?? "";
		open = true;
	}
	// From the map's "Deploy…": open straight away on that bubble.
	let asked = false;
	$effect(() => {
		if (!asked && rd.data && configs.length && new URLSearchParams(route.search).get("bubble")) ((asked = true), openDeploy());
	});
	async function start(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("POST", `/repos/${repo}/deploys`, { name, bubble });
			open = false;
			toast(`Deploying ${name} to ${bubbleName(bubble)}`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	const label = { running: "Running", succeeded: "Succeeded", failed: "Failed" } as const;
	const mark = { running: "running", succeeded: "merged", failed: "failed" } as const;
	const by = (who: string) => (/-[fsc]-/.test(who) ? `agent ${runId(who)}` : who);
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Deploy" }]}
	{repo}
	data={rd.data}
>
	<div class="page">
		<h1>Deploy</h1>
		<p class="lede">A deployment runs its command in a fresh sandbox on a bubble's current code. Start one by hand; set them up in <a href="/repos/{repo}/settings">settings</a>.</p>
		{#if rd.stale}<p class="callout stale" role="status"><Mark status="waiting" /><span>Can't reach the server. Retrying; these may be out of date.</span></p>{/if}
		{#if !rd.data}
			<p class="muted">Loading…</p>
		{:else if !configs.length}
			<div class="empty">
				<p>No deployments are set up yet.</p>
				<a class="button primary" href="/repos/{repo}/settings">Set one up in settings</a>
			</div>
		{:else if !bubbles.length}
			<p class="muted">There's nothing to deploy yet: the repository has no bubbles.</p>
		{:else}
			<button class="primary" onclick={() => openDeploy()}>Deploy…</button>
		{/if}
		{#if runs.length}
			<ul class="runs">
				{#each shown as d (d.id)}
					<li>
						<details open={d.status === "failed" && d === runs.find((x) => x.name === d.name)}>
							<summary>
								<span class="status {d.status}"><Mark status={mark[d.status]} />{label[d.status]}</span>
								<span class="mono">{d.name}</span>
								<span class="muted">on {bubbleName(d.bubble)} at <span class="mono">{d.head ? d.head.slice(0, 7) : "an unknown commit"}</span></span>
								<span class="muted small">by {by(d.by)}, {ago(d.started)}{d.finished ? `, took ${duration(d.finished - d.started)}` : ""}</span>
							</summary>
							<pre use:atFailure>{d.log || (d.status === "running" ? "Running…" : "(no output)")}</pre>
							{#if d.status !== "running" && configs.some((c) => c.name === d.name)}
								<div class="again"><button onclick={() => openDeploy(d.name, d.bubble)}>Run again</button></div>
							{/if}
						</details>
					</li>
				{/each}
			</ul>
			<Pager bind:page total={runs.length} />
		{:else if configs.length}
			<p class="muted none">Nothing deployed yet.</p>
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
			<select id="dep-bubble" bind:value={bubble} required>
				{#each bubbles as b (b.id)}
					{@const why = blocked(b)}
					<option value={b.id} disabled={!!why}>{b.name || short(b.id)}{why ? ` (${why})` : ""}</option>
				{/each}
			</select>
			<p class="hint">Deploys the bubble's code as it is now. A bubble that's merging, locked, or still applying changes has to wait.</p>
		</div>
		{#if config}
			<dl class="what">
				<dt>Runs</dt>
				<dd><code>{config.command}</code></dd>
				<dt>May reach</dt>
				<dd>{#if config.hosts.length}{#each config.hosts as h, i}<code>{h}</code>{i < config.hosts.length - 1 ? ", " : ""}{/each}{:else}only the git server{/if}</dd>
			</dl>
		{/if}
		<button class="primary" disabled={busy || !bubble}>Deploy {name}{bubble ? ` to ${bubbleName(bubble)}` : ""}</button>
	</form>
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 60rem; }
	.lede { margin: 0.4rem 0 1.25rem; color: var(--ink-2); max-width: 65ch; }
	.stale { margin-bottom: 1rem; }
	.empty { display: grid; justify-items: start; gap: 0.75rem; padding: 1.25rem; border: 1px dashed var(--line); border-radius: var(--r-md); }
	.none { margin-top: 1rem; }
	.runs { list-style: none; margin: 1.25rem 0 0; padding: 0; display: grid; gap: 0.5rem; }
	.runs li { border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); overflow: hidden; }
	summary { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; align-items: baseline; padding: 0.75rem 1rem 0.75rem 2rem; cursor: pointer; position: relative; list-style: none; }
	summary::-webkit-details-marker { display: none; }
	summary::before { content: ""; position: absolute; left: 0.9rem; top: 1.2rem; width: 0.4rem; height: 0.4rem; border: solid var(--ink-3); border-width: 0 1.5px 1.5px 0; rotate: -45deg; transition: rotate 150ms ease-out; }
	details[open] summary::before { rotate: 45deg; }
	summary:hover { background: var(--paper); }
	summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
	pre { margin: 0; padding: 0.75rem 1rem; border-top: 1px solid var(--line); max-height: 24rem; overflow: auto; font-size: 0.8125rem; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--paper); }
	.again { padding: 0.6rem 1rem; border-top: 1px solid var(--line-2); }
	.status { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 600; }
	.status.failed { color: var(--conflict); }
	.status.succeeded { color: var(--merged); }
	.small { font-size: 0.8125rem; }
	.what { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0 0 1.25rem; font-size: 0.875rem; }
	.what dt { color: var(--ink-2); }
	.what dd { margin: 0; overflow-wrap: anywhere; }
</style>
