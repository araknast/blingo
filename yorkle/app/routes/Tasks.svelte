<script lang="ts">
	// The repository's Tasks tab: an issue tracker. Lists tasks, or shows one (`id`).
	import { onDestroy } from "svelte";
	import Dialog from "../lib/Dialog.svelte";
	import ForkCommands from "../lib/ForkCommands.svelte";
	import RepoTabs from "../lib/RepoTabs.svelte";
	import Shell from "../lib/Shell.svelte";
	import SuperagentDialog from "../lib/SuperagentDialog.svelte";
	import { navigate } from "../lib/router.svelte";
	import { ApiError, api } from "../lib/session.svelte";
	import { toast, toastError } from "../lib/toast.svelte";
	import type { RepoState } from "../lib/types";
	import { poll, short } from "../lib/util";
	import TaskList from "./tasks/TaskList.svelte";
	import TaskView from "./tasks/TaskView.svelte";

	let { repo, id }: { repo: string; id?: string } = $props();

	let data = $state<RepoState | null>(null);
	let missing = $state(false);
	async function refresh() {
		try {
			data = await api<RepoState>("GET", `/repos/${repo}`);
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) missing = true;
			else if (!data) toastError(e);
		}
	}
	const stop = poll(refresh, 5000);
	onDestroy(stop);

	const open = $derived(data?.tasks.filter((t) => t.status !== "completed").length ?? 0);
	const task = $derived(id ? data?.tasks.find((t) => t.id === id) : undefined);
	const href = (t: string) => `/repos/${repo}/tasks/${t}`;

	// ---- Take a human task / retry a failed one ----
	let pushed = $state<{ fork: string; clone: string; push: string } | null>(null);
	let takeOpen = $state(false);
	async function take(t: string) {
		try {
			pushed = await api("POST", `/repos/${repo}/tasks/${t}/take`);
			takeOpen = true;
			refresh();
		} catch (e) {
			toastError(e);
		}
	}
	async function approve(t: string) {
		try {
			await api("POST", `/repos/${repo}/tasks/${t}/approve`);
			toast("Task approved");
			refresh();
		} catch (e) {
			toastError(e);
		}
	}
	async function editTask(t: string, title: string, description: string) {
		try {
			await api("PATCH", `/repos/${repo}/tasks/${t}`, { title, description });
			await refresh();
			return true;
		} catch (e) {
			toastError(e);
			return false;
		}
	}
	async function retry(t: string) {
		try {
			await api("POST", `/repos/${repo}/tasks/${t}/retry`);
			toast("Task reopened");
			refresh();
		} catch (e) {
			toastError(e);
		}
	}

	// ---- New task ----
	let newOpen = $state(false);
	let superOpen = $state(false);
	let title = $state("");
	let description = $state("");
	let kind = $state<"agent" | "notagent">("agent");
	let deps = $state<string[]>([]);
	let bubble = $state("");
	let busy = $state(false);
	async function create(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			const r = await api<{ task: string }>("POST", `/repos/${repo}/tasks`, {
				title,
				description,
				kind,
				deps,
				bubble: deps.length ? undefined : bubble || undefined,
			});
			newOpen = false;
			title = description = bubble = "";
			deps = [];
			await refresh();
			navigate(href(r.task));
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}
</script>

<Shell
	crumbs={[
		{ label: "Repositories", href: "/repos" },
		{ label: repo, href: `/repos/${repo}`, mono: true },
		...(id ? [{ label: "Tasks", href: `/repos/${repo}/tasks` }, { label: task?.title ?? `#${id.slice(2)}` }] : [{ label: "Tasks" }]),
	]}
	{repo}
>
	<RepoTabs {repo} current="tasks" {open} />
	<div class="page">
		{#if missing}
			<h1>This repository isn't available</h1>
			<p class="muted">It doesn't exist, or it belongs to someone else. <a href="/repos">Go to your repositories</a>.</p>
		{:else if !data}
			<p class="muted">Loading…</p>
		{:else if id}
			{#if task}
				<TaskView {task} {data} {href} {repo} ontake={take} onretry={retry} onapprove={approve} onedit={editTask} />
			{:else}
				<h1>No such task</h1>
				<p class="muted"><a href="/repos/{repo}/tasks">Back to the tasks</a></p>
			{/if}
		{:else}
			<TaskList {data} {href} ontake={take} onretry={retry} onnew={() => (newOpen = true)} onplan={() => (superOpen = true)} />
		{/if}
	</div>
</Shell>

<Dialog bind:open={takeOpen} title="Take this task" wide>
	{#if pushed}<ForkCommands {pushed} />{/if}
</Dialog>

<SuperagentDialog bind:open={superOpen} {repo} bubbles={data?.bubbles ?? []} onstarted={refresh} />

<Dialog bind:open={newOpen} title="New task" wide>
	<form onsubmit={create}>
		<div class="field">
			<label for="task-title">Title</label>
			<input id="task-title" bind:value={title} required maxlength="60" placeholder="Add a dark mode toggle" />
		</div>
		<div class="field">
			<label for="task-description">Description</label>
			<textarea id="task-description" bind:value={description} placeholder="What needs doing, in enough detail for an agent with no other context. Markdown works."></textarea>
		</div>
		<fieldset class="field">
			<legend>Assignee</legend>
			<label class="choice"><input type="radio" bind:group={kind} value="agent" /> Agent <span class="muted">starts by itself</span></label>
			<label class="choice"><input type="radio" bind:group={kind} value="notagent" /> Human <span class="muted">someone takes it and pushes</span></label>
		</fieldset>
		{#if data?.tasks.length}
			<fieldset class="field">
				<legend>Depends on</legend>
				<div class="deps">
					{#each data.tasks as t (t.id)}
						<label class="choice"><input type="checkbox" bind:group={deps} value={t.id} /> {t.title} <span class="muted mono">#{t.id.slice(2)}</span></label>
					{/each}
				</div>
				<p class="hint">It starts once one bubble holds all of these.</p>
			</fieldset>
		{/if}
		{#if !deps.length}
			<div class="field">
				<label for="task-bubble">Start from</label>
				<select id="task-bubble" bind:value={bubble}>
					<option value="">Any bubble</option>
					{#each data?.bubbles ?? [] as b (b.id)}<option value={b.id}>Bubble {short(b.id)}</option>{/each}
				</select>
			</div>
		{/if}
		<button class="primary" disabled={busy}>Create task</button>
	</form>
</Dialog>

<style>
	.page { padding: 1.5rem clamp(1rem, 3vw, 2.5rem) 3rem; max-width: 80rem; }
	.page > h1 + p { margin-top: 0.75rem; }
	fieldset { border: 0; padding: 0; margin: 0 0 1rem; min-width: 0; }
	legend { font-size: 0.875rem; font-weight: 500; margin-bottom: 0.3rem; padding: 0; }
	.choice { display: flex; gap: 0.5rem; align-items: baseline; font-weight: 400; margin: 0.2rem 0; }
	.choice input { width: auto; }
	.choice .muted { font-size: 0.8125rem; }
	.deps { max-height: 12rem; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 0.35rem 0.6rem; }
</style>
