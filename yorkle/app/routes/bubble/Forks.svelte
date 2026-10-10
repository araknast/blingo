<script lang="ts">
	import { parsePatch } from "diff";
	import Diff from "../../lib/Diff.svelte";
	import { forkDiff } from "../../lib/git";
	import { orderMembers } from "../../lib/layout";
	import type { Member } from "../../lib/types";
	import Pager, { PAGE } from "../../lib/Pager.svelte";
	import { plural, short } from "../../lib/util";

	let { repo, members }: { repo: string; members: Member[] } = $props();

	const sorted = $derived(orderMembers(members));
	let page = $state(0);
	const shown = $derived(sorted.slice(page * PAGE, (page + 1) * PAGE));
	let diffs = $state<Record<string, ReturnType<typeof parsePatch> | string>>({});
	let open = $state<Record<string, boolean>>({});

	async function toggle(m: Member) {
		open[m.name] = !open[m.name];
		if (!open[m.name] || m.name in diffs) return;
		try {
			diffs[m.name] = parsePatch(await forkDiff(repo, m.name));
		} catch (e) {
			diffs[m.name] = e instanceof Error ? e.message : String(e);
		}
	}

	const what = {
		rep: "Representative. The bubble's code lives in this fork.",
		pending: "Its patches are queued for the representative.",
		merged: "Merged into the representative.",
		conflict: "Couldn't merge: it conflicts with the bubble's code.",
		failed: "Its patches didn't apply to the representative.",
	};
</script>

{#if !sorted.length}
	<div class="panel note">No forks in this bubble.</div>
{:else}
	<ul class="forks">
		{#each shown as m (m.name)}
			<li class="panel">
				<div class="row">
					<i class="dot {m.status}"></i>
					<div class="main">
						<span class="mono name">{short(m.name)}</span>
						<span class="muted">{what[m.status]}</span>
					</div>
					{#if m.status === "merged"}
						<button class="small" aria-expanded={!!open[m.name]} onclick={() => toggle(m)}>{open[m.name] ? "Hide changes" : "Show changes"}</button>
					{/if}
				</div>
				{#if m.files.length}
					<details class="files">
						<summary>{plural(m.files.length, "file")} changed</summary>
						<ul>{#each m.files as f}<li><code>{f}</code></li>{/each}</ul>
					</details>
				{/if}
				{#if open[m.name]}
					{@const d = diffs[m.name]}
					{#if d === undefined}
						<p class="note">Loading changes</p>
					{:else if typeof d === "string"}
						<p class="note">{d}</p>
					{:else}
						{#each d as p}
							<div class="patch">
								<code class="patch-path">{(p.newFileName ?? p.oldFileName ?? "").replace(/^[ab]\//, "")}</code>
								<Diff hunks={p.hunks} />
							</div>
						{/each}
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
	<Pager bind:page total={sorted.length} />
{/if}

<style>
	.panel { background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
	.note { padding: 0.9rem 1.25rem; color: var(--ink-2); font-size: 0.875rem; }
	.forks { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.75rem; }
	.row { display: flex; align-items: center; gap: 0.85rem; padding: 0.8rem 1rem; }
	.main { flex: 1; display: flex; flex-wrap: wrap; gap: 0.25rem 0.85rem; align-items: baseline; font-size: 0.875rem; }
	.name { font-size: 0.875rem; }
	.small { padding: 0.3rem 0.7rem; font-size: 0.8125rem; }
	.files { padding: 0 1rem 0.75rem 2.45rem; font-size: 0.8125rem; }
	.files summary { cursor: pointer; color: var(--ink-2); }
	.files ul { list-style: none; padding: 0; margin: 0.4rem 0 0; display: grid; gap: 0.1rem; }
	.files code { font-size: 0.75rem; }
	.patch { border-top: 1px solid var(--line); }
	.patch-path { display: block; padding: 0.45rem 1rem; font-size: 0.75rem; background: var(--paper); border-bottom: 1px solid var(--line-2); }
</style>
