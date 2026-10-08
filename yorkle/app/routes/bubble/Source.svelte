<script lang="ts">
	import { onDestroy } from "svelte";
	import Code from "../../lib/Code.svelte";
	import Markdown from "../../lib/Markdown.svelte";
	import { MAX_SHOWN, file, isBinary, tree } from "../../lib/git";
	import { route } from "../../lib/router.svelte";
	import { ApiError } from "../../lib/session.svelte";
	import type { Commit, TreeEntry } from "../../lib/types";
	import { ago, firstLine } from "../../lib/util";

	let { repo, bubble, path, base }: { repo: string; bubble: string; path: string; base: string } = $props();

	// ?at=<commit> pins the view to a commit; otherwise the bubble's latest code.
	const at = new URLSearchParams(route.search).get("at") ?? undefined;
	const atQ = at ? `?at=${at}` : "";

	type View =
		| { kind: "tree"; commit: Commit | null; entries: TreeEntry[]; readme?: { name: string; text: string } }
		| { kind: "file"; size: number; text?: string; image?: string; binary?: boolean; truncated?: boolean; url: string }
		| { kind: "error"; message: string };
	let view = $state<View | null>(null);
	let urls: string[] = [];
	onDestroy(() => urls.forEach(URL.revokeObjectURL));
	const objectUrl = (b: Blob) => (urls.push(URL.createObjectURL(b)), urls.at(-1)!);

	async function load() {
		try {
			const t = await tree(repo, bubble, path, at);
			const entries = t.entries.toSorted((a, b) => Number(b.type === "tree") - Number(a.type === "tree") || a.name.localeCompare(b.name));
			view = { kind: "tree", commit: t.commit, entries };
			const readme = entries.find((e) => e.type !== "tree" && /^readme(\.md|\.markdown|\.txt)?$/i.test(e.name));
			if (readme) {
				const text = await (await file(repo, bubble, join(readme.name), at)).text();
				if (view.kind === "tree") view.readme = { name: readme.name, text };
			}
		} catch (e) {
			if (!(e instanceof ApiError && e.status === 404 && path)) return (view = { kind: "error", message: String((e as Error).message) });
			await loadFile();
		}
	}

	async function loadFile() {
		try {
			const b = await file(repo, bubble, path, at);
			const bytes = new Uint8Array(await b.arrayBuffer());
			const url = objectUrl(b);
			if (b.type.startsWith("image/")) return (view = { kind: "file", size: b.size, image: url, url });
			if (isBinary(bytes)) return (view = { kind: "file", size: b.size, binary: true, url });
			const text = new TextDecoder().decode(bytes.subarray(0, MAX_SHOWN));
			view = { kind: "file", size: b.size, text, truncated: b.size > MAX_SHOWN, url };
		} catch (e) {
			view = { kind: "error", message: e instanceof ApiError && e.status === 404 ? "There's no file or folder at this path." : String(e) };
		}
	}
	load();

	const join = (name: string) => (path ? `${path}/${name}` : name);
	const parts = $derived(path.split("/").filter(Boolean));
	const name = $derived(parts.at(-1) ?? "");
	const isMarkdown = $derived(/\.(md|markdown)$/i.test(name));
	let showSource = $state(false);
	const size = (n: number) => (n < 1024 ? `${n} bytes` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
	const lineCount = (t: string) => t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
</script>

<nav class="path" aria-label="Path">
	<a href="{base}/src/{atQ}">{bubble.split("-f-")[1] ?? bubble}</a>
	{#each parts as p, i}
		<span class="sep">/</span>
		{#if i < parts.length - 1}<a href="{base}/src/{parts.slice(0, i + 1).map(encodeURIComponent).join('/')}{atQ}">{p}</a>{:else}<strong>{p}</strong>{/if}
	{/each}
	{#if at}<span class="pinned">at commit <a class="mono" href="{base}/commits/{at}">{at.slice(0, 8)}</a> <a href="{base}/src/{parts.map(encodeURIComponent).join('/')}">Show latest</a></span>{/if}
</nav>

{#if !view}
	<div class="panel loading" aria-busy="true"><div class="bar"></div><div class="bar"></div><div class="bar short"></div></div>
{:else if view.kind === "error"}
	<div class="panel note">{view.message}</div>
{:else if view.kind === "tree"}
	{#if !view.commit}
		<div class="panel note">
			<strong>Nothing here yet.</strong>
			<p class="muted">This bubble has no commits. Code appears once an agent finishes or someone pushes a fork.</p>
		</div>
	{:else}
		<div class="panel">
			<a class="latest" href="{base}/commits/{view.commit.hash}">
				<span class="avatar" aria-hidden="true">{view.commit.author.name.slice(0, 1).toUpperCase()}</span>
				<span class="who">{view.commit.author.name}</span>
				<span class="msg">{firstLine(view.commit.message)}</span>
				<span class="mono hash">{view.commit.hash.slice(0, 8)}</span>
				<span class="muted when">{ago(view.commit.committedAt * 1000)}</span>
			</a>
			<table class="entries">
				<tbody>
					{#if path}
						<tr><td colspan="2"><a href="{base}/src/{parts.slice(0, -1).map(encodeURIComponent).join('/')}{atQ}" aria-label="Parent folder">..</a></td></tr>
					{/if}
					{#each view.entries as e (e.name)}
						<tr>
							<td class="icon" aria-hidden="true">
								{#if e.type === "tree"}
									<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" fill="var(--lilac)" stroke="var(--ink-3)" stroke-width="1" /></svg>
								{:else}
									<svg width="16" height="16" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="var(--ink-3)" stroke-width="1" /></svg>
								{/if}
							</td>
							<td>
								{#if e.type === "gitlink"}<span>{e.name} <span class="muted">(submodule)</span></span>
								{:else}<a href="{base}/src/{[...parts, e.name].map(encodeURIComponent).join('/')}{atQ}">{e.name}</a>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if view.readme}
			<div class="panel readme">
				<header class="file-head"><strong>{view.readme.name}</strong></header>
				{#if /\.txt$/i.test(view.readme.name) || !/\./.test(view.readme.name)}<Code text={view.readme.text} path={view.readme.name} />{:else}<Markdown text={view.readme.text} />{/if}
			</div>
		{/if}
	{/if}
{:else}
	<div class="panel">
		<header class="file-head">
			<strong>{name}</strong>
			<span class="muted">{#if view.text !== undefined}{lineCount(view.text)} lines, {/if}{size(view.size)}</span>
			<span class="spacer"></span>
			{#if isMarkdown && view.text !== undefined}
				<button class="small" onclick={() => (showSource = !showSource)}>{showSource ? "Preview" : "Source"}</button>
			{/if}
			<a class="button small" href={view.url} download={name}>Download</a>
		</header>
		{#if view.image}
			<div class="image"><img src={view.image} alt={name} /></div>
		{:else if view.binary}
			<p class="note">This is a binary file. Download it to open it.</p>
		{:else if isMarkdown && !showSource}
			<Markdown text={view.text ?? ""} />
		{:else}
			<Code text={view.text ?? ""} {path} />
			{#if view.truncated}<p class="note">Showing the first {size(MAX_SHOWN)}. Download the file to see all of it.</p>{/if}
		{/if}
	</div>
{/if}

<style>
	.path { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem; margin-bottom: 0.9rem; font-size: 0.9375rem; }
	.path a { color: var(--ink-2); text-decoration: none; }
	.path a:hover { text-decoration: underline; color: var(--ink); }
	.path a:first-child { font-family: var(--mono); font-size: 0.8125rem; }
	.sep { color: var(--ink-3); }
	.pinned { margin-left: auto; font-size: 0.8125rem; color: var(--ink-3); display: flex; gap: 0.5rem; align-items: baseline; }
	.pinned a { text-decoration: underline !important; }

	.panel { background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; margin-bottom: 1.25rem; }
	.note { padding: 1rem 1.25rem; color: var(--ink-2); }
	.note p { margin-top: 0.3rem; }

	.latest {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.7rem 1rem;
		border-bottom: 1px solid var(--line);
		background: var(--raised);
		text-decoration: none;
		font-size: 0.875rem;
	}
	.latest:hover .msg { text-decoration: underline; }
	.avatar { width: 1.5rem; height: 1.5rem; border-radius: 50%; display: grid; place-items: center; background: var(--line-2); font-size: 0.75rem; font-weight: 700; flex: none; }
	.who { font-weight: 500; flex: none; }
	.msg { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-2); }
	.hash { color: var(--ink-3); font-size: 0.75rem; }
	.when { flex: none; font-size: 0.8125rem; }

	.entries { width: 100%; border-collapse: collapse; }
	.entries td { padding: 0.5rem 0.25rem; border-bottom: 1px solid var(--line-2); font-size: 0.9375rem; }
	.entries tr:last-child td { border-bottom: 0; }
	.entries tr:hover { background: var(--raised); }
	.entries td.icon { width: 2.5rem; padding-left: 1rem; }
	.entries svg { display: block; }
	.entries a { text-decoration: none; }
	.entries a:hover { text-decoration: underline; }

	.file-head { display: flex; align-items: center; gap: 0.75rem; padding: 0.6rem 1rem; border-bottom: 1px solid var(--line); flex-wrap: wrap; font-size: 0.875rem; }
	.spacer { flex: 1; }
	.small { padding: 0.25rem 0.65rem; font-size: 0.8125rem; }
	.image { padding: 1.5rem; display: grid; place-items: center; background: repeating-conic-gradient(var(--line-2) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
	.image img { max-width: 100%; }

	.loading { padding: 1rem 1.25rem; display: grid; gap: 0.75rem; }
	.bar { height: 0.8rem; border-radius: 4px; background: var(--line-2); animation: shimmer 1.2s ease-in-out infinite alternate; }
	.bar.short { width: 40%; }
	@keyframes shimmer { to { opacity: 0.45; } }

	@media (max-width: 640px) {
		.hash, .who { display: none; }
	}
</style>
