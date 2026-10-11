<script lang="ts">
	// One agent run: its Claude Code transcript (stream-json events from GET /agents/:id/transcript),
	// polled while it runs. Each tool call is one row with its result; text and the result stay open.
	import { onDestroy, tick as nextTick } from "svelte";
	import Code from "../../lib/Code.svelte";
	import { ask } from "../../lib/confirm.svelte";
	import Mark from "../../lib/Mark.svelte";
	import Markdown from "../../lib/Markdown.svelte";
	import { api } from "../../lib/session.svelte";
	import { toast, toastError } from "../../lib/toast.svelte";
	import type { AgentRun, RepoState } from "../../lib/types";
	import { ago, compact, duration, poll, runId, runLabel, runMark } from "../../lib/util";
	import { elapsed as fmtElapsed } from "../../lib/elapsed";

	let {
		repo,
		id,
		run,
		task,
		kind,
		data,
		forkHref = (fork: string) => `/repos/${repo}/forks/${fork}`,
	}: { repo: string; id: string; run?: AgentRun; task?: string; kind: string; data?: RepoState | null; forkHref?: (fork: string) => string } = $props();

	// Its fork, while it waits outside a bubble (for CI, a review, or a person).
	const loose = $derived(data?.loose.find((l) => l.fork === id));

	let stopping = $state(false);
	async function stopAgent() {
		if (!task || !(await ask({ title: "Stop this agent?", body: "Its work so far is discarded. Its transcript is kept, so a retry can pick up from it.", confirm: "Stop agent", danger: true }))) return;
		stopping = true;
		try {
			await api("POST", `/repos/${repo}/tasks/${task}/stop`);
			toast("Agent stopped");
		} catch (e) {
			toastError(e);
		} finally {
			stopping = false;
		}
	}

	type Block = { type: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; tool_use_id?: string; id?: string };
	type Event = { type: string; subtype?: string; model?: string; message?: { content?: Block[] | string }; result?: string; is_error?: boolean; num_turns?: number; duration_ms?: number; hook_event?: string; output?: string; text?: string; bytes?: number };
	let events = $state<Event[]>([]);
	let status = $state("none");
	let reason = $state<string>(); // why the run failed after the agent finished: its change wasn't submitted
	let usage = $state<{ input: number; output: number; cacheRead: number; cacheWrite: number }>(); // tokens so far
	let loaded = $state(false);
	let cursor = 0;
	let stop = () => {};
	stop = poll(async () => {
		try {
			const t = await api<{ status: string; reason?: string; usage?: typeof usage; events: Event[]; next: number }>("GET", `/agents/${id}/transcript?from=${cursor}`);
			if (status === "running" && t.status !== "running") {
				// The run just ended: replace the live copy with the stored one.
				const full = await api<{ events: Event[]; next: number }>("GET", `/agents/${id}/transcript?from=0`);
				events = full.events;
				cursor = full.next;
			} else {
				if (t.events.length) events = [...events, ...t.events]; // reassigning resets the elapsed timer
				cursor = t.next;
			}
			status = t.status;
			reason = t.reason;
			usage = t.usage;
			loaded = true;
			if (status !== "running") stop();
		} catch {
			loaded = true;
		}
	}, 1500);
	onDestroy(() => stop());

	// Live feedback while running: what it's doing now, and for how long. The spinner holds still when
	// motion is reduced.
	const glyphs = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
	const verbs = ["Thinking", "Pondering", "Reasoning", "Tinkering", "Cooking", "Weaving", "Mulling"];
	const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	let tick = $state(0);
	const timer = setInterval(() => tick++, reduced ? 1000 : 100);
	onDestroy(() => clearInterval(timer));
	let lastChange = $state(Date.now());
	$effect(() => {
		events.length;
		lastChange = Date.now();
	});
	const elapsed = $derived.by(() => {
		tick;
		return fmtElapsed(Date.now() - lastChange);
	});
	const live = $derived((run?.status ?? status) === "running");

	// One scrollable box; follow new output unless the reader has scrolled up.
	let box = $state<HTMLElement>();
	let pinned = $state(true);
	const onscroll = () => (pinned = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24);
	$effect(() => {
		events.length;
		if (live && pinned) nextTick().then(() => box?.scrollTo({ top: box.scrollHeight }));
	});

	const init = $derived(events.find((e) => e.type === "system" && e.subtype === "init"));
	const blocks = (e: Event): Block[] => (Array.isArray(e.message?.content) ? e.message.content : typeof e.message?.content === "string" ? [{ type: "text", text: e.message.content }] : []);
	// A tool result's content: a string, or text blocks.
	const output = (c: unknown) =>
		typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string; type?: string }) => x.text ?? `[${x.type}]`).join("\n") : JSON.stringify(c, null, 2);
	const json = (x: unknown) => JSON.stringify(x, null, 2);

	// The transcript as rows: a tool call carries its result (matched by id); runs of more than FOLD
	// tool calls in a row fold into one group.
	type Tool = { id?: string; name: string; input: Record<string, any>; result?: string; error?: boolean };
	type Item =
		| { kind: "text"; text: string }
		| { kind: "thinking"; text: string }
		| { kind: "tool"; tool: Tool }
		| { kind: "tools"; tools: Tool[] }
		| { kind: "event"; e: Event };
	const FOLD = 3;
	const items = $derived.by(() => {
		const out: Item[] = [];
		const byId = new Map<string, Tool>();
		for (const e of events) {
			if (e.type === "assistant") {
				for (const b of blocks(e)) {
					if (b.type === "text" && b.text?.trim()) out.push({ kind: "text", text: b.text });
					else if (b.type === "thinking") out.push({ kind: "thinking", text: b.thinking ?? "" });
					else if (b.type === "tool_use") {
						const tool: Tool = { id: b.id, name: b.name ?? "tool", input: (b.input ?? {}) as Record<string, any> };
						if (b.id) byId.set(b.id, tool);
						out.push({ kind: "tool", tool });
					}
				}
			} else if (e.type === "user") {
				for (const b of blocks(e)) {
					if (b.type !== "tool_result") continue;
					const tool = b.tool_use_id ? byId.get(b.tool_use_id) : undefined;
					if (tool) Object.assign(tool, { result: output(b.content), error: !!b.is_error });
					else out.push({ kind: "tool", tool: { name: "Result", input: {}, result: output(b.content), error: !!b.is_error } });
				}
			} else if (e.type !== "system" || (e.subtype === "hook_response" && hookContext(e.output))) out.push({ kind: "event", e });
		}
		// Fold runs of tool rows (the run still being written stays open, so live output is visible).
		const folded: Item[] = [];
		for (let i = 0; i < out.length; ) {
			let j = i;
			while (j < out.length && out[j].kind === "tool") j++;
			if (j - i > FOLD && j < out.length) folded.push({ kind: "tools", tools: out.slice(i, j).map((x) => (x as { tool: Tool }).tool) }), (i = j);
			else if (j > i) folded.push(...out.slice(i, j)), (i = j);
			else folded.push(out[i++]);
		}
		return folded;
	});

	// What it's doing: the tool call still waiting for its result, else the model.
	const doing = $derived.by(() => {
		const open = items.findLast((it) => it.kind === "tool" && it.tool.result === undefined);
		return open?.kind === "tool" ? `Running ${open.tool.name}` : verbs[Math.floor(tick / (reduced ? 4 : 40)) % verbs.length];
	});
	const failedTools = $derived(items.flatMap((it) => (it.kind === "tool" ? [it.tool] : it.kind === "tools" ? it.tools : [])).filter((t) => t.error).length);
	function jumpToFailure() {
		const el = box?.querySelector<HTMLDetailsElement>("details.tool.error");
		if (!el) return;
		el.closest<HTMLDetailsElement>("details.group")?.setAttribute("open", "");
		el.open = true;
		el.scrollIntoView({ block: "center" });
		el.querySelector("summary")?.focus();
	}
	const result = $derived(events.findLast((e) => e.type === "result"));
	const rel = (p?: string) => (typeof p === "string" ? p.replace(/^\/workspace\/repo\//, "") : "");
	// What a tool call did, in one line.
	function summary(t: Tool): string {
		const i = t.input;
		switch (t.name) {
			case "Bash": return i.command ?? "";
			case "Read": case "Write": case "Edit": case "MultiEdit": return rel(i.file_path);
			case "NotebookEdit": return rel(i.notebook_path);
			case "Grep": return `${i.pattern ?? ""}${i.path ? ` in ${rel(i.path)}` : ""}`;
			case "Glob": return i.pattern ?? "";
			case "WebFetch": return i.url ?? "";
			case "WebSearch": return i.query ?? "";
			case "TodoWrite": return `${(i.todos ?? []).length} to-dos`;
			default: return typeof i.description === "string" ? i.description : "";
		}
	}
	// Edit / MultiEdit as removed and added lines.
	const edits = (t: Tool): { old_string?: string; new_string?: string }[] => (t.name === "MultiEdit" ? (t.input.edits ?? []) : [t.input]);
	const lines = (s?: string) => (s ?? "").split("\n");
	const hookContext = (o?: string) => {
		try {
			return JSON.parse(o ?? "").hookSpecificOutput?.additionalContext ?? "";
		} catch {
			return "";
		}
	};
</script>

<header class="head">
	<p class="kind">{[kind, runId(id), init?.model].filter(Boolean).join(" · ")}</p>
	<h1 tabindex="-1">{run?.prompt.split("\n")[0] ?? id}</h1>
	<p class="status" role="status">
		{#if run}<Mark status={runMark(run, data)} />{/if}
		<span>{[
			run ? runLabel(run, data) : status === "running" ? "Working" : "",
			run && (run.finished ? `took ${duration(run.finished - run.started)}` : `started ${ago(run.started)}`),
			usage && `${compact(usage.input + usage.cacheRead + usage.cacheWrite)} tokens in · ${compact(usage.output)} out`,
			result?.num_turns && `${result.num_turns} ${result.num_turns === 1 ? "turn" : "turns"}`,
		]
			.filter(Boolean)
			.join(" · ")}</span>
	</p>
	{#if live && task}<button class="stop danger" onclick={stopAgent} disabled={stopping}>{stopping ? "Stopping…" : "Stop agent"}</button>{/if}
</header>

{#if loose && (loose.reviewManual === "pending" || loose.kind === "notagent")}
	<p class="callout lead"><Mark status={loose.reviewManual === "pending" ? "review" : "failed"} /><span>{loose.reviewManual === "pending" ? "Its fork is waiting for your review." : (loose.reason ?? "A person has taken over its fork.")} <a href={forkHref(id)}>Open its fork</a></span></p>
{/if}
{#if reason}
	<p class="callout lead"><Mark status="failed" /><span><strong>Its change wasn't submitted:</strong> {reason}</span></p>
{/if}
{#if result?.is_error}
	<p class="callout lead"><Mark status="failed" /><span><strong>It ended with an error.</strong> {#if failedTools}<button class="link" onclick={jumpToFailure}>Jump to the first failed tool call</button>{/if}</span></p>
{/if}

{#snippet tool(t: Tool)}
	<details class="tool" class:error={t.error}>
		<summary>
			<Mark status={t.error ? "failed" : t.result !== undefined ? "merged" : live ? "running" : "waiting"} label={t.error ? "Failed" : t.result !== undefined ? "Done" : live ? "Running" : "No result"} />
			<span class="name">{t.name}</span>
			<span class="arg" title={summary(t)}>{summary(t)}</span>
		</summary>
		<div class="body">
			{#if t.name === "Bash"}
				<pre class="cmd"><span class="prompt">$</span> {t.input.command}</pre>
			{:else if (t.name === "Edit" || t.name === "MultiEdit") && edits(t).some((x) => typeof x.old_string === "string")}
				<div class="diff">
					{#each edits(t) as x, n}
						{#if n}<div class="hunk">⋯</div>{/if}
						{#each lines(x.old_string) as l}<div class="del">- {l}</div>{/each}
						{#each lines(x.new_string) as l}<div class="add">+ {l}</div>{/each}
					{/each}
				</div>
			{:else if t.name === "Write" && typeof t.input.content === "string"}
				<div class="code"><Code text={t.input.content} path={rel(t.input.file_path)} /></div>
			{:else if t.name === "TodoWrite" && Array.isArray(t.input.todos)}
				<ul class="todos">
					{#each t.input.todos as td}<li class={td.status}><span class="check">{td.status === "completed" ? "☑" : td.status === "in_progress" ? "◐" : "☐"}</span> {td.content}</li>{/each}
				</ul>
			{:else if !["Read", "Glob", "Grep"].includes(t.name) && Object.keys(t.input).length}
				<pre>{json(t.input)}</pre>
			{/if}
			{#if t.result !== undefined && t.result.trim() && t.name !== "TodoWrite"}
				<pre class="out" class:err={t.error}>{t.result}</pre>
			{:else if t.result === undefined}
				<p class="muted pad">{live ? "Running…" : "No result was recorded."}</p>
			{/if}
		</div>
	</details>
{/snippet}

{#snippet spin()}
	<p class="thinking"><span class="glyph" aria-hidden="true">{reduced ? "·" : glyphs[tick % glyphs.length]}</span> {doing}… <span class="muted">({elapsed})</span></p>
{/snippet}

{#if !loaded}
	<p class="muted">Loading…</p>
{:else if !events.length}
	<p class="muted">{status === "running" ? "The agent is starting. Its transcript shows up here as it works." : "No transcript was kept for this run."}</p>
	{#if live}{@render spin()}{/if}
{:else}
	<div class="box" bind:this={box} {onscroll}>
	<ol class="events">
		{#each items as it, i (i)}
			{#if it.kind === "text"}
				<li class="text"><Markdown text={it.text} /></li>
			{:else if it.kind === "thinking"}
				<li><details class="quiet"><summary><span class="mark">✻</span> Thinking</summary>{#if it.text}<pre class="thought">{it.text}</pre>{:else}<p class="muted pad">Its thinking isn't shown.</p>{/if}</details></li>
			{:else if it.kind === "tool"}
				<li>{@render tool(it.tool)}</li>
			{:else if it.kind === "tools"}
				<li>
					<details class="group">
						<summary><span class="mark">⋯</span> {it.tools.length} tool calls <span class="muted">{[...new Set(it.tools.map((t) => t.name))].join(", ")}</span>{#if it.tools.some((t) => t.error)}<span class="err">&nbsp;· {it.tools.filter((t) => t.error).length} failed</span>{/if}</summary>
						<ol class="events nested">{#each it.tools as t}<li>{@render tool(t)}</li>{/each}</ol>
					</details>
				</li>
			{:else if it.e.type === "system"}
				<li><details class="quiet"><summary><span class="mark">✎</span> Memory update <span class="muted">({it.e.hook_event})</span></summary><pre>{hookContext(it.e.output)}</pre></details></li>
			{:else if it.e.type === "result"}
				<li class="result callout" class:ok={!it.e.is_error}>
					<strong>{it.e.is_error ? "Ended with an error" : "Finished"}</strong>
					{#if it.e.result}<Markdown text={it.e.result} />{/if}
				</li>
			{:else if it.e.type === "truncated"}
				<li class="muted">An event of {Math.round((it.e.bytes ?? 0) / 1000)} KB was too big to keep.</li>
			{:else if it.e.type === "raw" && it.e.text}
				<li><pre class="plain">{it.e.text}</pre></li>
			{/if}
		{/each}
	</ol>
	{#if live}
		{@render spin()}
	{/if}
	</div>
	{#if live && !pinned}<button class="latest" onclick={() => ((pinned = true), box?.scrollTo({ top: box.scrollHeight, behavior: "smooth" }))}>Jump to latest</button>{/if}
{/if}
{#if run?.log}
	<details class="log"><summary>Sandbox log</summary><pre>{run.log}</pre></details>
{/if}
<p class="back"><a href="/repos/{repo}/agents">All agents</a></p>

<style>
	.head { margin-bottom: 1.25rem; }
	.stop { margin-top: 0.25rem; }
	.kind { font-size: 0.8125rem; color: var(--ink-3); overflow-wrap: anywhere; }
	.status { display: flex; align-items: center; gap: 0.45rem; color: var(--ink-2); font-size: 0.9375rem; }
	.lead { margin-bottom: 1rem; }
	.link { background: none; border: 0; padding: 0; color: var(--focus); text-decoration: underline; font: inherit; }
	.danger { color: var(--conflict); }
	.latest { position: sticky; bottom: 1rem; margin: -2.75rem auto 0; display: flex; box-shadow: 0 4px 14px rgb(15 24 33 / 0.18); }
	.head h1 { margin: 0.2rem 0 0.4rem; overflow-wrap: anywhere; }
	.box { max-height: calc(100vh - 15rem); min-height: 10rem; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-md); padding: 0.75rem; background: var(--paper); }
	.events { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.35rem; }
	.events li { min-width: 0; }
	.nested { padding: 0.4rem 0.5rem 0.5rem 1.4rem; }
	.text { padding: 0.15rem 0; }
	.text :global(.md) { padding: 0.25rem 0.25rem; max-width: none; }
	details { border-radius: var(--r-sm); }
	summary { cursor: pointer; padding: 0.35rem 0.6rem; font-size: 0.8125rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; list-style: none; border-radius: var(--r-sm); }
	summary::-webkit-details-marker { display: none; }
	summary:hover { background: var(--fog); }
	.mark { display: inline-block; width: 1.1em; color: var(--ink-3); font-family: var(--mono); }
	.quiet summary { color: var(--ink-2); }
	.group { border: 1px dashed var(--line); }
	.group > summary { color: var(--ink-2); white-space: normal; }
	.err { color: var(--conflict); }

	/* A tool call: a status dot, the tool, its main argument; the body is input then output. */
	.tool { font-family: var(--mono); }
	.tool > summary { display: flex; align-items: baseline; gap: 0.55rem; }
	.tool > summary :global(.mark) { align-self: center; }
	.name { flex: none; font-weight: 600; color: var(--ink); }
	.arg { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); }
	.tool.error .name { color: var(--conflict); }
	.tool[open] > summary { background: var(--fog); border-radius: var(--r-sm) var(--r-sm) 0 0; }
	.body { border: 1px solid var(--line-2); border-top: 0; border-radius: 0 0 var(--r-sm) var(--r-sm); background: var(--raised); overflow: hidden; }
	.body > :not(:first-child) { border-top: 1px solid var(--line-2); }
	pre { margin: 0; padding: 0.55rem 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 0.75rem; line-height: 1.5; max-height: 24rem; overflow: auto; }
	.plain { border: 1px solid var(--line-2); border-radius: var(--r-sm); }
	.cmd { color: var(--ink); }
	.prompt { color: var(--merged); user-select: none; }
	.out { color: var(--ink-2); background: var(--paper); }
	.out.err { color: var(--del-ink); background: var(--del-bg); }
	.diff { font-family: var(--mono); font-size: 0.75rem; line-height: 1.5; max-height: 24rem; overflow: auto; }
	.diff > div { padding: 0 0.75rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	.diff .del { background: var(--del-bg); color: var(--del-ink); }
	.diff .add { background: var(--add-bg); color: var(--add-ink); }
	.diff .hunk { color: var(--ink-3); }
	.code { max-height: 24rem; overflow: auto; font-size: 0.75rem; }
	.todos { list-style: none; margin: 0; padding: 0.5rem 0.75rem; font-size: 0.8125rem; display: grid; gap: 0.15rem; }
	.todos .completed { color: var(--ink-3); text-decoration: line-through; }
	.todos .in_progress { font-weight: 600; }
	.todos .check { display: inline-block; width: 1.2em; }
	.thought { font-family: var(--font); font-style: italic; color: var(--ink-2); border-left: 2px solid var(--line); margin: 0.2rem 0 0.2rem 0.9rem; max-height: none; }
	.pad { padding: 0.5rem 0.75rem; margin: 0; font-size: 0.8125rem; }
	.result { display: block; margin-top: 0.5rem; }
	.result :global(.md) { padding: 0.4rem 0; }
	.thinking { margin-top: 0.75rem; font-size: 0.875rem; color: var(--ink-2); }
	.glyph { display: inline-block; width: 1em; font-family: var(--mono); color: var(--ink); }
	.log { margin-top: 1.5rem; }
	.back { margin-top: 1.5rem; }
</style>
