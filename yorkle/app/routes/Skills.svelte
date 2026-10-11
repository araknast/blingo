<script lang="ts">
	// The repository's skills: Claude Code skill folders that agents can load.
	import { ask } from "../lib/confirm.svelte";
	import Markdown from "../lib/Markdown.svelte";
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
	// A skill's contents, fetched when its row is opened.
	type Contents = { skillMd: string; files: { path: string; bytes: number }[] };
	let contents = $state<Record<string, Contents | "loading" | "error">>({});
	async function load(name: string, open: boolean) {
		if (!open || contents[name]) return;
		contents[name] = "loading";
		try {
			contents[name] = await api<Contents>("GET", `/repos/${repo}/skills/${encodeURIComponent(name)}`);
		} catch {
			contents[name] = "error";
		}
	}
	const body = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n?/, ""); // without its frontmatter
	const size = (n: number) => (n < 1000 ? `${n} B` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} KB`);
	// Tasks not finished yet that picked this skill by name.
	const usedBy = (name: string) => rd.data?.tasks.filter((t) => t.status !== "completed" && t.skills?.includes(name)).length ?? 0;
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
		// Check what the server would refuse before sending a megabyte, and ask before replacing a skill.
		const md = picked.find((f) => (f.webkitRelativePath || f.name).split("/").slice(1).join("/") === "SKILL.md" || f.name === "SKILL.md");
		if (!md) return toastError("That folder has no SKILL.md at its top level.");
		if (picked.length > 200) return toastError(`A skill can have at most 200 files; that folder has ${picked.length}.`);
		if (picked.reduce((n, f) => n + f.size, 0) > 1_000_000) return toastError("A skill can be at most 1 MB.");
		const name = (await md.text()).match(/^name:\s*(\S+)/m)?.[1];
		const replacing = !!name && items.some((s) => s.name === name);
		if (replacing && !(await ask({ title: `Replace ${name}?`, body: `A skill called ${name} is already here. Uploading this folder replaces it for every agent that loads it.`, confirm: "Replace skill" })))
			return;
		busy = true;
		try {
			const files = await Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, data: await b64(f) })));
			const r = await api<{ name: string }>("POST", `/repos/${repo}/skills`, { files });
			toast(replacing ? `Skill ${r.name} replaced` : `Skill ${r.name} added`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
	async function remove(name: string) {
		const named = usedBy(name);
		if (!(await ask({ title: `Remove ${name}?`, body: `New agents stop loading it.${named ? ` ${named === 1 ? "A task names" : `${named} tasks name`} it and will start without it.` : ""}`, confirm: "Remove skill", danger: true })))
			return;
		try {
			await api("DELETE", `/repos/${repo}/skills/${encodeURIComponent(name)}`);
			toast(`Skill ${name} removed`);
			await rd.refresh();
		} catch (err) {
			toastError(err);
		}
	}
</script>

<Shell
	crumbs={[{ label: "Repositories", href: "/repos" }, { label: repoName(repo, session.me?.names), href: `/repos/${repo}` }, { label: "Skills" }]}
	{repo}
	data={rd.data}
>
	<div class="page">
		<h1>Skills</h1>
		<p class="lede">Claude Code skills for this repository. A new agent loads all of them unless whoever starts it picks some, so a skill added here reaches every agent from now on. Upload a skill folder: it needs a <span class="mono">SKILL.md</span> with a name and description, and can be up to 1 MB.</p>
		<label class="upload button primary" class:busy
			>{busy ? "Uploading…" : "Upload skill folder"}
			<input class="visually-hidden" type="file" webkitdirectory multiple disabled={busy} onchange={upload} />
		</label>
		{#if !rd.data}
			<p class="muted">Loading…</p>
		{:else if !items.length}
			<p class="muted">No skills yet. Agents run with Claude Code's own.</p>
		{:else}
			<ul class="skills">
				{#each shown as s (s.name)}
					<li>
						<p><span class="mono">{s.name}</span></p>
						<p class="muted">{s.description}</p>
						<span class="muted small">added {ago(s.created)}{#if usedBy(s.name)} · named by {usedBy(s.name) === 1 ? "a task" : `${usedBy(s.name)} tasks`}{/if}</span>
						<button class="quiet" aria-label="Remove {s.name}" onclick={() => remove(s.name)}>Remove</button>
						<details class="contents" ontoggle={(e) => load(s.name, (e.currentTarget as HTMLDetailsElement).open)}>
							<summary>What's in it</summary>
							{#if contents[s.name] === "loading" || !contents[s.name]}
								<p class="muted">Loading…</p>
							{:else if contents[s.name] === "error"}
								<p class="muted">Couldn't load it. Close and open this again to retry.</p>
							{:else}
								{@const c = contents[s.name] as Contents}
								<ul class="files">{#each c.files as f (f.path)}<li><span class="mono">{f.path}</span><span class="muted">{size(f.bytes)}</span></li>{/each}</ul>
								<div class="skill-md"><Markdown text={body(c.skillMd)} /></div>
							{/if}
						</details>
					</li>
				{/each}
			</ul>
			<Pager bind:page total={items.length} />
		{/if}
	</div>
</Shell>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 52rem; }
	.lede { margin: 0.4rem 0 1.25rem; color: var(--ink-2); max-width: 65ch; }
	.upload { display: inline-flex; margin-bottom: 1.5rem; cursor: pointer; }
	.upload:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
	.upload.busy { opacity: 0.6; cursor: progress; }
	.skills { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.skills > li { display: grid; grid-template-columns: 1fr auto; gap: 0.15rem 1rem; padding: 0.75rem 1rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--raised); }
	.skills p { overflow-wrap: anywhere; }
	.skills > li > button { grid-row: 1 / span 3; grid-column: 2; align-self: center; }
	.contents { grid-column: 1 / -1; margin-top: 0.35rem; font-size: 0.875rem; }
	.contents summary { cursor: pointer; color: var(--ink-2); width: max-content; }
	.contents[open] summary { margin-bottom: 0.5rem; }
	.files { list-style: none; margin: 0 0 0.75rem; padding: 0.5rem 0.75rem; display: grid; gap: 0.15rem; background: var(--paper); border-radius: var(--r-sm); }
	.files li { display: flex; justify-content: space-between; gap: 1rem; }
	.skill-md { max-height: 24rem; overflow: auto; border-top: 1px solid var(--line-2); }
	.small { font-size: 0.8125rem; }
</style>
