<script lang="ts">
	// Repository settings (PUT /repos/:r/settings), and deleting the repository. Ordered by what's at stake:
	// without a key no agent starts, so models and keys come first; deployments, the biggest form, last.
	import { onDestroy } from "svelte";
	import { ask } from "../lib/confirm.svelte";
	import Dialog from "../lib/Dialog.svelte";
	import Mark from "../lib/Mark.svelte";
	import Shell from "../lib/Shell.svelte";
	import { repoState } from "../lib/repoState.svelte";
	import { leave, navigate } from "../lib/router.svelte";
	import { api, loadMe, session } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { Settings } from "../lib/types";
	import { repoName } from "../lib/util";

	type DeployForm = { name: string; command: string; hostsText: string; auth: { host: string; header: string; value: string; hasValue: boolean }[] };
	type Form = Omit<Settings, "ci" | "deploys"> & { ci: Settings["ci"] & { hostsText: string }; deploys: DeployForm[] };

	// No `repo`: the account's defaults for new repositories (GET/PUT /me/defaults), without deployments.
	let { repo }: { repo?: string } = $props();
	// svelte-ignore state_referenced_locally (the page is keyed by repo in App)
	const rd = repo ? repoState(repo, 15000) : null;
	let defaults = $state<Settings | null>(null);
	const reload = async () => (rd ? await rd.refresh() : (defaults = await api<Settings>("GET", "/me/defaults")));
	if (!rd) reload().catch(toastError);
	const where = $derived(repo ? "Stored for this repository only" : "Copied into each repository you create");
	// "anthropic": only a key saved before that provider was dropped.
	const PROVIDER = { anthropic: "Anthropic API", openrouter: "OpenRouter", "claude-subscription": "Claude subscription" } as const;

	// The form's copy, taken once the settings arrive (polls don't overwrite edits in progress), and the
	// saved values it started from, to tell what's changed.
	let form = $state<Form | null>(null);
	let saved = $state("");
	const toForm = (s: Settings): Form => ({
		...$state.snapshot(s),
		ci: { ...$state.snapshot(s.ci), hostsText: s.ci.hosts.join(", ") },
		deploys: s.deploys.map((d) => ({ name: d.name, command: d.command, hostsText: d.hosts.join(", "), auth: d.auth.map((a) => ({ ...a, value: "" })) })),
	});
	$effect(() => {
		const s = rd ? rd.data?.settings : defaults;
		if (s && !form) ((form = toForm(s)), (saved = JSON.stringify(form)));
	});
	let apiKey = $state("");
	let reviewerKey = $state("");
	// Removing a key waits for Save, like every other change.
	let dropKey = $state(false);
	let dropReviewerKey = $state(false);
	let busy = $state(false);
	const dirty = $derived(!!form && (JSON.stringify(form) !== saved || !!apiKey || !!reviewerKey || dropKey || dropReviewerKey));

	// The stored key belongs to one provider; switching provider needs a new one.
	const keyFor = $derived(form?.hasKey && !dropKey ? (form.keyProvider ?? null) : null);
	const keyMismatch = $derived(!!form && !!keyFor && keyFor !== form.provider && !apiKey);

	async function save(e?: SubmitEvent) {
		e?.preventDefault();
		if (!form) return false;
		busy = true;
		try {
			// Only what changed here: the server merges it, so a save doesn't undo changes made elsewhere since.
			const { ci, deploys, hasKey: _, hasReviewerKey: __, keyProvider: ___, ...rest } = form;
			const was = JSON.parse(saved) as Form;
			const changed = (k: string, now: unknown) => JSON.stringify(now) !== JSON.stringify((was as Record<string, unknown>)[k]);
			const body: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([k, v]) => changed(k, v)));
			if (changed("ci", ci)) body.ci = { enabled: ci.enabled, command: ci.command, hosts: split(ci.hostsText) };
			if (changed("deploys", deploys)) body.deploys = deploys.map(deployBody);
			if (apiKey) body.apiKey = apiKey;
			else if (dropKey) body.apiKey = "";
			if (reviewerKey) body.reviewerKey = reviewerKey;
			else if (dropReviewerKey) body.reviewerKey = "";
			// The key is checked against the provider it's saved for, so a new key sends the provider too.
			if (body.apiKey && !("provider" in body)) body.provider = form.provider;
			await api("PUT", repo ? `/repos/${repo}/settings` : "/me/defaults", body);
			apiKey = reviewerKey = "";
			dropKey = dropReviewerKey = false;
			// The save landed, so treat what the form holds as the stored state right away. The refresh
			// below re-fetches the whole repo and can take a while; without this, leaving during it would
			// warn about changes that are already saved.
			saved = JSON.stringify(form);
			await reload();
			form = null; // take the saved values (after the refresh, or the stale ones come back)
			toast("Settings saved");
			return true;
		} catch (err) {
			toastError(err);
			return false;
		} finally {
			busy = false;
		}
	}
	function discard() {
		apiKey = reviewerKey = "";
		dropKey = dropReviewerKey = false;
		form = null;
	}
	const split = (t: string) => t.split(/[\s,]+/).filter(Boolean);
	// A header's value is sent only when typed; blank keeps the stored one.
	const deployBody = (d: DeployForm) => ({ name: d.name, command: d.command, hosts: split(d.hostsText), auth: d.auth.map((a) => ({ host: a.host, header: a.header, ...(a.value ? { value: a.value } : {}) })) });
	function addDeploy() {
		form!.deploys.push({ name: "", command: "", hostsText: "", auth: [] });
	}
	async function removeDeploy(i: number) {
		const d = form!.deploys[i];
		const creds = d.auth.filter((a) => a.hasValue).length;
		if (d.name && !(await ask({ title: `Remove ${d.name}?`, body: `It's removed when you save${creds ? `, with its ${creds === 1 ? "stored credential" : `${creds} stored credentials`}` : ""}. Its past runs stay on the Deploy tab.`, confirm: "Remove deployment", danger: true })))
			return;
		form!.deploys.splice(i, 1);
	}

	// Unsaved changes: the browser asks before closing the tab, and leaving for another page asks here.
	const beforeUnload = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
	addEventListener("beforeunload", beforeUnload);
	$effect(() => {
		leave.guard = dirty ? () => ask({ title: "Leave without saving?", body: "Your changes to the settings are lost.", confirm: "Leave", danger: true }) : null;
	});
	onDestroy(() => {
		removeEventListener("beforeunload", beforeUnload);
		leave.guard = null;
	});

	let deleteOpen = $state(false);
	let confirmName = $state("");
	$effect(() => {
		if (!deleteOpen) confirmName = "";
	});
	async function destroy(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			await api("DELETE", `/repos/${repo}`);
			await loadMe();
			leave.guard = null;
			toast(`Deleted ${repoName(repo!, session.me?.names)}`);
			navigate("/repos");
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Shell
	crumbs={repo
		? [{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Settings" }]
		: [{ label: "Repositories", href: "/repos" }, { label: "Defaults" }]}
	{repo}
	sidebar={!!repo}
	data={rd?.data}
>
	<div class="page">
		{#if repo}
			<h1>Settings</h1>
		{:else}
			<h1>Defaults for new repositories</h1>
			<p class="hint lede">Every repository you create starts with these settings and keys. Changing them doesn't change existing repositories.</p>
		{/if}
		{#if !form}
			<p class="muted">Loading…</p>
		{:else}
			<form onsubmit={save}>
				<section>
					<h2>Agents and models</h2>
					<div class="field">
						<label for="provider">Provider</label>
						<select id="provider" bind:value={form.provider}>
							<option value="claude-subscription">Claude subscription</option>
							<option value="openrouter">OpenRouter</option>
						</select>
					</div>
					<div class="field">
						<label for="api-key">{form.provider === "claude-subscription" ? "Subscription token" : "API key"}</label>
						<div class="row">
							<input
								id="api-key"
								type="password"
								autocomplete="new-password"
								bind:value={apiKey}
								aria-describedby="api-key-hint"
								placeholder={dropKey ? "Removed when you save" : form.hasKey ? `${keyFor ? `${PROVIDER[keyFor]} key` : "A key"} is set. Type a new one to replace it` : "Required: agents don't start without one"}
							/>
							{#if form.hasKey}
								{#if dropKey}<button type="button" onclick={() => (dropKey = false)}>Keep it</button>
								{:else}<button type="button" onclick={() => ((dropKey = true), (apiKey = ""))}>Remove</button>{/if}
							{/if}
						</div>
						{#if keyMismatch}
							<p class="callout warn"><Mark status="failed" /><span>The saved key is for {PROVIDER[keyFor!]}. Paste {form.provider === "claude-subscription" ? "a Claude subscription token" : "an OpenRouter key"}, or agents won't start.</span></p>
						{:else if dropKey}
							<p class="callout warn"><Mark status="failed" /><span>When you save, the key is removed and no new agent starts until there's another.</span></p>
						{/if}
						<p class="hint" id="api-key-hint">{where}, never shown again, and never given to a sandbox.{#if form.provider === "claude-subscription"} Run <span class="mono">claude setup-token</span> locally and paste the result. Agents bill to your subscription and share its usage limits, so many at once may be rate limited.{/if}</p>
					</div>
					<datalist id="models">
						<option value="claude-opus-5-5"></option>
						<option value="claude-sonnet-5-5"></option>
						<option value="claude-haiku-5-5"></option>
						{#if form.provider === "openrouter"}<option value="anthropic/claude-sonnet-5-5"></option><option value="deepseek/deepseek-v4.1-flash"></option>{/if}
					</datalist>
					<div class="models">
						{#each [["agent", "Agents"], ["superagent", "Superagents"], ["ferge", "Ferge agents"]] as [role, label] (role)}
							<div class="field">
								<label for="model-{role}">{label}</label>
								<input id="model-{role}" class="mono" list="models" autocomplete="off" bind:value={form.models[role as "agent"]} placeholder="Provider's default" />
							</div>
						{/each}
					</div>
					<p class="hint">Model ids as {PROVIDER[form.provider]} names them. Blank uses its default.</p>
				</section>

				<section>
					<h2>CI and review</h2>
					<label class="check"><input type="checkbox" bind:checked={form.ci.enabled} /> Run CI on every push before a fork is placed</label>
					<fieldset class="sub" disabled={!form.ci.enabled}>
						<div class="field">
							<label for="ci-command">Command</label>
							<input id="ci-command" class="mono" bind:value={form.ci.command} placeholder="npm ci && npm test" aria-describedby="ci-command-hint" />
							<p class="hint" id="ci-command-hint">Runs in a fresh sandbox on the pushed commit. Leave it empty to only review.</p>
						</div>
						<div class="field">
							<label for="ci-hosts">Hosts CI may reach</label>
							<input id="ci-hosts" class="mono" bind:value={form.ci.hostsText} placeholder="registry.npmjs.org" aria-describedby="ci-hosts-hint" />
							<p class="hint" id="ci-hosts-hint">Besides the git server. Separate them with commas. CI never gets an API key.</p>
						</div>
						<div class="field">
							<label for="pushes">Pushes an agent gets to pass CI</label>
							<input id="pushes" class="short" type="number" min="1" max="20" bind:value={form.maxAgentPushes} aria-describedby="pushes-hint" />
							<p class="hint" id="pushes-hint">1 to 20. Each failure starts an agent to fix it. After the last, a person takes over the fork.</p>
						</div>
					</fieldset>
					<div class="field">
						<label for="review">Review</label>
						<select id="review" bind:value={form.review} aria-describedby="review-hint">
							<option value="none">None</option>
							<option value="auto">Automatic (an agent reviews it)</option>
							<option value="manual">Manual (you approve it)</option>
							<option value="both">Both</option>
						</select>
						<p class="hint" id="review-hint">Manual reviews wait in the map's Needs you list.</p>
					</div>
					{#if form.review === "auto" || form.review === "both"}
						<div class="field">
							<label for="reviewer-key">Reviewer OpenRouter key{form.provider === "claude-subscription" ? "" : " (optional)"}</label>
							<div class="row">
								<input
									id="reviewer-key"
									type="password"
									autocomplete="new-password"
									bind:value={reviewerKey}
									aria-describedby="reviewer-hint"
									placeholder={dropReviewerKey ? "Removed when you save" : form.hasReviewerKey ? "A key is set. Type a new one to replace it" : form.provider === "claude-subscription" ? "Required: a subscription token can't review" : "Defaults to the repository's key"}
								/>
								{#if form.hasReviewerKey}
									{#if dropReviewerKey}<button type="button" onclick={() => (dropReviewerKey = false)}>Keep it</button>
									{:else}<button type="button" onclick={() => ((dropReviewerKey = true), (reviewerKey = ""))}>Remove</button>{/if}
								{/if}
							</div>
							<p class="hint" id="reviewer-hint">The reviewer calls OpenRouter directly. {where} and never shown again.{#if form.provider === "claude-subscription"} A subscription token can't review, so automatic review needs this key.{/if}</p>
						</div>
					{/if}
				</section>

				<section>
					<h2>Placing forks</h2>
					<label class="check"><input type="checkbox" bind:checked={form.autoPlaceNotagents} aria-describedby="place-hint" /> Place notagents' forks as soon as they're pushed (and pass CI)</label>
					<p class="hint" id="place-hint">Off: pushed forks wait in the map's Needs you list until you place them.</p>
				</section>

				<section>
					<h2>Conflicts</h2>
					<label class="check"><input type="checkbox" bind:checked={form.autoFerge} aria-describedby="ferge-hint" /> Ferge conflicting bubbles automatically</label>
					<p class="hint" id="ferge-hint">The merge loop ferges conflicting pairs alongside its neighbour merges, oldest first: the two merge without the files they conflict on, and a new locked bubble holds those files until someone fixes and unlocks it.</p>
					<label class="check"><input type="checkbox" bind:checked={form.fergeAgents} aria-describedby="ferge-agents-hint" /> After a ferge, start an agent to resolve its conflicts</label>
					<p class="hint" id="ferge-agents-hint">The agent works on a fork of the locked bubble with the Ferge agents model. The bubble unlocks itself once the agent's fix lands in it. While it works, the conflicts are its alone. With both on, conflicts don't show under "Needs you"; a ferge whose agent failed does.</p>
				</section>

				<section>
					<h2>Tasks</h2>
					<label class="check"><input type="checkbox" bind:checked={form.taskApproval} aria-describedby="approval-hint" /> New tasks wait for approval before they merge</label>
					<p class="hint" id="approval-hint">Every new task, including a superagent's plan and ferge agents', starts as usual, but its fork doesn't merge until you approve it on the Tasks tab. Until then the task reads as awaiting approval.</p>
				</section>

				{#if repo}
				<section>
					<h2>Deployments</h2>
					<p class="hint lede">Run by hand from the Deploy tab, on a bubble's code, in a fresh sandbox that can reach only the git server and the hosts listed. A header's value is added to requests to its host outside the sandbox, so the command never sees it.</p>
					{#each form.deploys as d, i}
						{@const label = d.name || `Deployment ${i + 1}`}
						<fieldset class="deploy">
							<legend>{label}</legend>
							<div class="field">
								<label for="dep-name-{i}">Name</label>
								<input id="dep-name-{i}" bind:value={d.name} required pattern={"[\\w-]{1,40}"} placeholder="production" aria-describedby="dep-name-hint-{i}" />
								<p class="hint" id="dep-name-hint-{i}">Letters, digits, - and _, up to 40.</p>
							</div>
							<div class="field">
								<label for="dep-cmd-{i}">Command</label>
								<input id="dep-cmd-{i}" class="mono" bind:value={d.command} required placeholder="npm ci && npx wrangler deploy" />
							</div>
							<div class="field">
								<label for="dep-hosts-{i}">Hosts it may reach</label>
								<input id="dep-hosts-{i}" class="mono" bind:value={d.hostsText} placeholder="registry.npmjs.org, api.cloudflare.com" />
							</div>
							{#if d.auth.length}
								<p class="cred-head">Credential headers</p>
								{#each d.auth as a, j}
									<div class="cred">
										<input aria-label="{label}, header {j + 1}: host" class="mono" bind:value={a.host} placeholder="api.cloudflare.com" />
										<input aria-label="{label}, header {j + 1}: name" class="mono" bind:value={a.header} placeholder="Authorization" />
										<input aria-label="{label}, header {j + 1}: value" type="password" autocomplete="new-password" bind:value={a.value} placeholder={a.hasValue ? "Set. Type to replace" : "Value"} />
										<button type="button" aria-label="Remove {label}'s header {j + 1}" onclick={() => d.auth.splice(j, 1)}>Remove</button>
									</div>
								{/each}
							{/if}
							<div class="row deploy-actions">
								<button type="button" onclick={() => d.auth.push({ host: "", header: "", value: "", hasValue: false })}>Add a credential header</button>
								<button type="button" class="quiet danger" onclick={() => removeDeploy(i)}>Remove {label}</button>
							</div>
						</fieldset>
					{/each}
					<button type="button" onclick={addDeploy}>Add a deployment</button>
				</section>
				{/if}

				<div class="savebar" class:dirty>
					<span class="state" role="status">{dirty ? "You have unsaved changes" : "All changes saved"}</span>
					{#if dirty}<button type="button" class="quiet" onclick={discard}>Discard</button>{/if}
					<button class="primary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save settings"}</button>
				</div>
			</form>
		{/if}

		{#if repo}
		<section class="danger-zone">
			<h2>Delete repository</h2>
			<p class="hint">Deletes every bubble, fork and record in it. It can't be undone.</p>
			<button class="danger" onclick={() => (deleteOpen = true)}>Delete repository</button>
		</section>
		{/if}
	</div>
</Shell>

<Dialog bind:open={deleteOpen} title="Delete this repository?">
	<form onsubmit={destroy}>
		<p class="intro">This deletes every bubble, fork and agent record in <strong>{repoName(repo!, session.me?.names)}</strong>. It can't be undone.</p>
		<div class="field">
			<label for="confirm">Type <span class="mono">{repo}</span> to confirm</label>
			<input id="confirm" autocomplete="off" bind:value={confirmName} />
		</div>
		<button class="primary danger-fill" disabled={busy || confirmName !== repo}>Delete repository</button>
	</form>
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 0; max-width: 46rem; }
	h1 { margin-bottom: 1rem; }
	section { padding: 1.25rem 0 0.5rem; border-top: 1px solid var(--line-2); }
	h2 { font-size: 1.0625rem; margin-bottom: 0.75rem; }
	.check { display: flex; gap: 0.5rem; align-items: center; font-weight: 400; margin-bottom: 0.4rem; }
	.check input { width: auto; }
	.check + .hint { margin: -0.2rem 0 0.9rem 1.6rem; max-width: 65ch; }
	.lede { margin: -0.25rem 0 1rem; max-width: 65ch; }
	.row { display: flex; gap: 0.5rem; }
	.row input { flex: 1; min-width: 0; }
	.short { width: 6rem; }
	.models { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: 0 0.75rem; }
	.models .field { margin-bottom: 0.5rem; }
	.callout.warn { margin-top: 0.5rem; font-size: 0.875rem; }
	fieldset.sub { border: 0; padding: 0; margin: 0; min-width: 0; }
	fieldset.sub:disabled { opacity: 0.55; }
	.deploy { border: 1px solid var(--line); border-radius: var(--r-md); padding: 0.5rem 1rem 0.75rem; margin: 0 0 0.75rem; min-width: 0; }
	.deploy legend { font-weight: 600; font-size: 0.9375rem; padding: 0 0.35rem; }
	.cred-head { font-size: 0.875rem; font-weight: 500; margin: 0.25rem 0 0.35rem; }
	.cred { display: grid; grid-template-columns: 1fr 1fr 1fr auto; gap: 0.4rem; margin-bottom: 0.4rem; }
	.cred input { min-width: 0; }
	.deploy-actions { flex-wrap: wrap; margin-top: 0.5rem; }
	.danger { color: var(--conflict); }
	.savebar {
		position: sticky;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-top: 1.25rem;
		padding: 0.75rem 0;
		background: var(--fog);
		border-top: 1px solid var(--line-2);
		z-index: 5;
	}
	.savebar .state { margin-right: auto; font-size: 0.875rem; color: var(--ink-2); }
	.savebar.dirty .state { color: var(--ink); font-weight: 600; }
	.danger-zone { margin: 2.5rem 0 3rem; }
	.danger-zone .hint { margin: 0 0 0.75rem; }
	.intro { margin-bottom: 1rem; color: var(--ink-2); }
	@media (max-width: 600px) {
		.row { flex-wrap: wrap; }
		.cred { grid-template-columns: 1fr 1fr; }
	}
</style>
