<script lang="ts">
	import FileDiff from "../../lib/FileDiff.svelte";
	import { commit } from "../../lib/git";
	import type { Change, Commit } from "../../lib/types";
	import { isRun } from "../../lib/attention";
	import { ago, firstLine, plural } from "../../lib/util";

	let { repo, bubble, hash, base }: { repo: string; bubble: string; hash: string; base: string } = $props();

	let data = $state<{ commit: Commit; files: Change[] } | null>(null);
	let error = $state("");
	$effect(() => {
		commit(repo, bubble, hash).then(
			(d) => (data = d),
			(e) => (error = e instanceof Error ? e.message : String(e)),
		);
	});

	let split = $state(false);
	try {
		split = localStorage.getItem("yorkle-diff") === "split";
	} catch {}
	$effect(() => {
		try {
			localStorage.setItem("yorkle-diff", split ? "split" : "unified");
		} catch {}
	});

	const body = (m: string) => m.split("\n").slice(1).join("\n").trim();
	const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
	const mark = { added: "A", removed: "D", modified: "M" };
</script>

{#if error}
	<div class="panel note">{error}</div>
{:else if !data}
	<div class="panel note">Loading commit</div>
{:else}
	{@const c = data.commit}
	<article class="panel head">
		<h2>{firstLine(c.message)}</h2>
		{#if body(c.message)}<pre class="body">{body(c.message)}</pre>{/if}
		<dl>
			<div><dt>Author</dt><dd>{#if isRun(c.author.name)}<a href="/repos/{repo}/agents/{c.author.name}">{c.author.name}</a>{:else}{c.author.name}{/if} <span class="muted">&lt;{c.author.email}&gt;</span></dd></div>
			<div><dt>Committed</dt><dd title={new Date(c.committedAt * 1000).toLocaleString()}>{ago(c.committedAt * 1000)}</dd></div>
			<div><dt>Commit</dt><dd class="mono">{c.hash}</dd></div>
			{#if c.parents.length}
				<div>
					<dt>{c.parents.length > 1 ? "Parents" : "Parent"}</dt>
					<dd>{#each c.parents as p, i}<a class="mono" href="{base}/commits/{p}">{p.slice(0, 8)}</a>{i < c.parents.length - 1 ? ", " : ""}{/each}</dd>
				</div>
			{/if}
		</dl>
		<a class="button small browse" href="{base}/src/?at={c.hash}">Browse code at this commit</a>
	</article>

	<div class="bar">
		<h3>{plural(data.files.length, "file")} changed{c.parents.length > 1 ? " compared with the first parent" : ""}</h3>
		<div class="seg" role="group" aria-label="Diff layout">
			<button class:on={!split} aria-pressed={!split} onclick={() => (split = false)}>Unified</button>
			<button class:on={split} aria-pressed={split} onclick={() => (split = true)}>Side by side</button>
		</div>
	</div>

	{#if data.files.length > 1}
		<ul class="panel summary">
			{#each data.files as f, i}
				<li><span class="m {f.status}" title={f.status}>{mark[f.status]}</span><a href="#file-{i}">{f.path}</a></li>
			{/each}
		</ul>
	{/if}

	<div class="files">
		{#each data.files as f, i (f.path)}
			<FileDiff {repo} fork={bubble} change={f} {split} id="file-{i}" viewHref="{base}/src/{encPath(f.path)}?at={c.hash}" />
		{/each}
	</div>
{/if}

<style>
	.panel { background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); margin: 0 0 1.25rem; }
	.note { padding: 1rem 1.25rem; color: var(--ink-2); }
	.head { padding: 1.25rem 1.5rem; position: relative; }
	.head h2 { font-size: 1.25rem; max-width: 60ch; padding-right: 13rem; }
	.body { margin: 0.75rem 0 0; white-space: pre-wrap; font-family: var(--font); font-size: 0.9375rem; color: var(--ink-2); max-width: 72ch; }
	dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, max-content)); gap: 0.5rem 2.5rem; margin: 1.1rem 0 0; }
	dt { font-size: 0.75rem; color: var(--ink-3); }
	dd { margin: 0; font-size: 0.875rem; overflow-wrap: anywhere; }
	dd.mono { font-size: 0.75rem; }
	.browse { position: absolute; top: 1.25rem; right: 1.5rem; }
	.small { padding: 0.3rem 0.7rem; font-size: 0.8125rem; }
	.bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
	.bar h3 { font-size: 0.9375rem; }
	.seg { display: inline-flex; }
	.seg button { border-radius: 0; padding: 0.3rem 0.75rem; font-size: 0.8125rem; }
	.seg button:first-child { border-radius: var(--r-sm) 0 0 var(--r-sm); }
	.seg button:last-child { border-radius: 0 var(--r-sm) var(--r-sm) 0; margin-left: -1px; }
	.seg .on { background: var(--harbor); border-color: var(--harbor); color: #fff; }
	.summary { list-style: none; padding: 0.4rem 0; max-height: 16rem; overflow: auto; }
	.summary li { display: flex; gap: 0.75rem; align-items: center; padding: 0.2rem 1rem; font-size: 0.8125rem; }
	.summary a { font-family: var(--mono); font-size: 0.75rem; text-decoration: none; overflow-wrap: anywhere; }
	.summary a:hover { text-decoration: underline; }
	.m { font-family: var(--mono); font-size: 0.6875rem; width: 1.1rem; height: 1.1rem; display: grid; place-items: center; border-radius: 3px; background: var(--line-2); flex: none; }
	.m.added { background: var(--add-bg); color: var(--add-ink); }
	.m.removed { background: var(--del-bg); color: var(--del-ink); }
	.files { display: grid; gap: 1rem; }
	@media (max-width: 720px) {
		.head h2 { padding-right: 0; }
		.browse { position: static; margin-top: 1rem; }
	}
	@media (prefers-color-scheme: dark) { .seg .on { background: #d9e2ea; border-color: #d9e2ea; color: #0f1821; } }
</style>
