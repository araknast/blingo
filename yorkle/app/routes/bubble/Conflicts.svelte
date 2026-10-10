<script lang="ts">
	// A ferge bubble's conflicts: the files its ferge commit wrote with conflict markers that still have
	// them. Pick a side (or both, or write it) for each conflict; the result goes in as a person's fork
	// of this bubble and is placed back into it. Then unlocking lets the bubble merge back.
	import { type Choice, type Part, hasConflicts, parseConflicts, resolve } from "../../lib/conflicts";
	import { commit, file, log } from "../../lib/git";
	import { api } from "../../lib/session.svelte";
	import { toast, toastError } from "../../lib/toast.svelte";
	import { plural } from "../../lib/util";

	let { repo, bubble, locked, onchange }: { repo: string; bubble: string; locked: boolean; onchange?: () => void } = $props();

	const FERGE_COMMIT = "ferge: conflicting files with conflict markers";
	type Conflicted = { path: string; parts: Part[]; choices: (Choice | undefined)[] };
	let files = $state<Conflicted[] | null>(null);
	let error = $state("");
	let busy = $state(false);
	let sent = $state<{ fork: string; placing: boolean } | null>(null);

	async function load() {
		try {
			const c = (await log(repo, bubble, 0, 100)).find((x) => x.message.trim() === FERGE_COMMIT);
			if (!c) return (files = []);
			const changed = (await commit(repo, bubble, c.hash)).files.filter((f) => f.status !== "removed");
			const texts = await Promise.all(changed.map(async (f) => ({ path: f.path, text: await (await file(repo, bubble, f.path)).text().catch(() => "") })));
			files = texts.filter((t) => hasConflicts(t.text)).map((t) => ({ path: t.path, parts: parseConflicts(t.text), choices: [] }));
		} catch (e) {
			error = String((e as Error).message ?? e);
		}
	}
	load();

	const conflictsIn = (f: Conflicted) => f.parts.filter((p) => !("text" in p)).length;
	const total = $derived(files?.reduce((n, f) => n + conflictsIn(f), 0) ?? 0);
	const chosen = $derived(files?.reduce((n, f) => n + f.choices.filter(Boolean).length, 0) ?? 0);
	const results = $derived(files?.map((f) => resolve(f.parts, f.choices)) ?? []);
	const ready = $derived(!!files?.length && results.every((r) => r !== null && !hasConflicts(r)));

	// The conflict index of each part (undefined for plain text).
	const indexes = (parts: Part[]) => {
		let n = 0;
		return parts.map((p) => ("text" in p ? undefined : n++));
	};
	const custom = (c: Choice | undefined) => (typeof c === "object" ? c.custom : undefined);
	const lines = (s: string) => s.replace(/\n$/, "").split("\n");

	async function submit() {
		if (!files || !ready) return;
		busy = true;
		try {
			const body = Object.fromEntries(files.map((f, i) => [f.path, results[i]!]));
			sent = await api<{ fork: string; placing: boolean }>("POST", `/repos/${repo}/ferge/${bubble}/resolve`, { files: body });
			toast(sent.placing ? "Resolution sent: it's being placed in this bubble" : "Resolution pushed: it's waiting for CI or a review");
			onchange?.();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}

	async function unlock() {
		busy = true;
		try {
			await api("POST", `/repos/${repo}/unlock`, { bubble });
			toast("Unlocked: the bubble can merge back now");
			onchange?.();
		} catch (e) {
			toastError(e);
		} finally {
			busy = false;
		}
	}
</script>

{#if error}
	<div class="panel note">{error}</div>
{:else if !files}
	<div class="panel loading" aria-busy="true"><div class="bar"></div><div class="bar"></div><div class="bar short"></div></div>
{:else if sent}
	<div class="panel note">
		{#if sent.placing}
			<p>Your resolution is being placed in this bubble. Once its fork shows on the Forks tab, unlock the bubble so it merges back.</p>
		{:else}
			<p>Your resolution was pushed to <a href="/repos/{repo}/forks/{sent.fork}">its fork</a>, which waits for CI or a review before it's placed here.</p>
		{/if}
		{#if locked}<button onclick={unlock} disabled={busy}>Unlock bubble</button>{/if}
	</div>
{:else if !files.length}
	<div class="panel note">
		<p>No conflict markers are left in this bubble.</p>
		{#if locked}<p class="muted">Unlock it so it can merge back into the rest.</p><button class="primary" onclick={unlock} disabled={busy}>Unlock bubble</button>{/if}
	</div>
{:else}
	<div class="bar-top">
		<p class="muted">{plural(total, "conflict")} in {plural(files.length, "file")}: {chosen} resolved.</p>
		<button class="primary" onclick={submit} disabled={busy || !ready}>{busy ? "Sending…" : "Resolve"}</button>
	</div>
	{#each files as f (f.path)}
		<section class="panel file">
			<header class="file-head"><strong class="mono">{f.path}</strong><span class="muted">{f.choices.filter(Boolean).length} of {conflictsIn(f)}</span></header>
			{#each f.parts as p, i}
				{@const n = indexes(f.parts)[i]}
				{#if "text" in p}
					<pre class="ctx">{p.text.replace(/\n$/, "")}</pre>
				{:else if n !== undefined}
					<div class="conflict" class:done={f.choices[n] !== undefined}>
						<div class="sides">
							<div class="side ours" class:picked={f.choices[n] === "ours" || f.choices[n] === "both"}>
								<p class="label">This bubble <span class="mono muted">{p.oursLabel}</span></p>
								<pre>{#each lines(p.ours) as l}<span>{l}</span>{"\n"}{/each}</pre>
							</div>
							<div class="side theirs" class:picked={f.choices[n] === "theirs" || f.choices[n] === "both"}>
								<p class="label">The absorbed bubble <span class="mono muted">{p.theirsLabel}</span></p>
								<pre>{#each lines(p.theirs) as l}<span>{l}</span>{"\n"}{/each}</pre>
							</div>
						</div>
						<div class="pick" role="group" aria-label="Resolve this conflict">
							{#each [["ours", "Keep this bubble's"], ["theirs", "Keep the absorbed one's"], ["both", "Keep both"]] as [c, label]}
								<button class="small" aria-pressed={f.choices[n] === c} onclick={() => (f.choices[n] = c as Choice)}>{label}</button>
							{/each}
							<button class="small" aria-pressed={custom(f.choices[n]) !== undefined} onclick={() => (f.choices[n] = { custom: custom(f.choices[n]) ?? p.ours + p.theirs })}>Edit</button>
						</div>
						{#if custom(f.choices[n]) !== undefined}
							<textarea
								class="mono"
								aria-label="Resolved text"
								rows={Math.min(16, lines(custom(f.choices[n])!).length + 1)}
								value={custom(f.choices[n])}
								oninput={(e) => (f.choices[n] = { custom: e.currentTarget.value })}
							></textarea>
						{/if}
					</div>
				{/if}
			{/each}
			{#if results[files.indexOf(f)] !== null && hasConflicts(results[files.indexOf(f)]!)}<p class="warn">The text still has conflict markers.</p>{/if}
		</section>
	{/each}
{/if}

<style>
	.bar-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.9rem; }
	.file { margin-bottom: 1rem; overflow: hidden; }
	.file-head { display: flex; justify-content: space-between; gap: 1rem; }
	pre { margin: 0; padding: 0 0.9rem; font-family: var(--mono); font-size: 0.75rem; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
	.ctx { color: var(--ink-3); padding-top: 0.3rem; padding-bottom: 0.3rem; max-height: 12rem; overflow: auto; }
	.conflict { border-block: 1px solid var(--line-2); border-left: 3px solid var(--conflict); background: var(--paper); }
	.conflict.done { border-left-color: var(--merged); }
	.sides { display: grid; grid-template-columns: 1fr 1fr; }
	.side { min-width: 0; padding-bottom: 0.4rem; opacity: 0.75; }
	.side.picked { opacity: 1; }
	.side + .side { border-left: 1px solid var(--line-2); }
	.ours.picked { background: var(--add-bg); }
	.theirs.picked { background: var(--add-bg); }
	.label { margin: 0; padding: 0.4rem 0.9rem 0.2rem; font-size: 0.75rem; font-weight: 600; color: var(--ink-2); }
	.pick { display: flex; flex-wrap: wrap; gap: 0.4rem; padding: 0.5rem 0.9rem; border-top: 1px solid var(--line-2); }
	.pick button[aria-pressed="true"] { background: var(--harbor); border-color: var(--harbor); color: #fff; }
	textarea { display: block; width: calc(100% - 1.8rem); margin: 0 0.9rem 0.6rem; font-size: 0.75rem; }
	.warn { margin: 0; padding: 0.5rem 0.9rem; color: var(--conflict); font-size: 0.8125rem; }
	.note p { margin: 0 0 0.75rem; }
	@media (max-width: 700px) {
		.sides { grid-template-columns: 1fr; }
		.side + .side { border-left: 0; border-top: 1px solid var(--line-2); }
	}
</style>
