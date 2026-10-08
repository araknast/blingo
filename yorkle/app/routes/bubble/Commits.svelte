<script lang="ts">
	import { log } from "../../lib/git";
	import type { Commit } from "../../lib/types";
	import { ago, firstLine } from "../../lib/util";

	let { repo, bubble, base }: { repo: string; bubble: string; base: string } = $props();

	const PAGE = 30;
	let commits = $state<Commit[]>([]);
	let more = $state(true);
	let loading = $state(false);
	let error = $state("");

	async function next() {
		loading = true;
		try {
			const page = await log(repo, bubble, commits.length, PAGE);
			commits.push(...page);
			more = page.length === PAGE;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
	next();

	const day = (c: Commit) => new Date(c.committedAt * 1000).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
	const groups = $derived.by(() => {
		const out: { day: string; commits: Commit[] }[] = [];
		for (const c of commits) {
			const d = day(c);
			if (out.at(-1)?.day !== d) out.push({ day: d, commits: [] });
			out.at(-1)!.commits.push(c);
		}
		return out;
	});
</script>

{#if error}
	<div class="panel note">{error}</div>
{:else if !commits.length && !loading}
	<div class="panel note">No commits yet. They appear once an agent finishes or someone pushes a fork.</div>
{/if}

{#each groups as g (g.day)}
	<h2 class="day">{g.day}</h2>
	<ol class="panel list">
		{#each g.commits as c (c.hash)}
			<li>
				<a class="row" href="{base}/commits/{c.hash}">
					<span class="avatar" aria-hidden="true">{c.author.name.slice(0, 1).toUpperCase()}</span>
					<span class="main">
						<span class="msg">{firstLine(c.message)}</span>
						<span class="muted meta">
							{c.author.name} committed {ago(c.committedAt * 1000)}
							{#if c.parents.length > 1}<span class="tag">Merge of {c.parents.length}</span>{/if}
						</span>
					</span>
					<span class="mono hash">{c.hash.slice(0, 8)}</span>
				</a>
			</li>
		{/each}
	</ol>
{/each}

{#if more && commits.length}
	<button onclick={next} disabled={loading}>{loading ? "Loading" : "Show older commits"}</button>
{/if}

<style>
	.panel { background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; margin: 0 0 1.25rem; }
	.note { padding: 1rem 1.25rem; color: var(--ink-2); }
	.day { font-size: 0.875rem; font-weight: 500; color: var(--ink-3); margin: 0 0 0.5rem; }
	.list { list-style: none; padding: 0; }
	.list li + li { border-top: 1px solid var(--line-2); }
	.row { display: flex; align-items: center; gap: 0.85rem; padding: 0.7rem 1rem; text-decoration: none; }
	.row:hover { background: var(--raised); }
	.row:hover .msg { text-decoration: underline; }
	.avatar { width: 1.75rem; height: 1.75rem; border-radius: 50%; display: grid; place-items: center; background: var(--line-2); font-size: 0.8125rem; font-weight: 700; flex: none; }
	.main { flex: 1; min-width: 0; display: grid; }
	.msg { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.meta { font-size: 0.8125rem; display: flex; gap: 0.5rem; align-items: center; }
	.tag { font-size: 0.6875rem; padding: 0 0.4rem; border-radius: 999px; background: var(--line-2); color: var(--ink-2); }
	.hash { color: var(--ink-2); font-size: 0.75rem; padding: 0.15rem 0.45rem; border: 1px solid var(--line); border-radius: var(--r-sm); }
</style>
