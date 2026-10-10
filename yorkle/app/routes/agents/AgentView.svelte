<script lang="ts">
	// One agent run: its Claude Code transcript (stream-json events from GET /agents/:id/transcript),
	// polled while it runs. Thinking, tool calls and results fold away; text and the result stay open.
	import { onDestroy, tick as nextTick } from "svelte";
	import Markdown from "../../lib/Markdown.svelte";
	import { api } from "../../lib/session.svelte";
	import type { AgentRun } from "../../lib/types";
	import { agentLabel, ago, duration, poll } from "../../lib/util";

	let { repo, id, run, kind }: { repo: string; id: string; run?: AgentRun; kind: string } = $props();

	type Block = { type: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; tool_use_id?: string; id?: string };
	type Event = { type: string; subtype?: string; model?: string; message?: { content?: Block[] | string }; result?: string; is_error?: boolean; total_cost_usd?: number; num_turns?: number; duration_ms?: number; hook_event?: string; output?: string; text?: string; bytes?: number };
	let events = $state<Event[]>([]);
	let status = $state("none");
	let loaded = $state(false);
	let cursor = 0;
	let stop = () => {};
	stop = poll(async () => {
		try {
			const t = await api<{ status: string; events: Event[]; next: number }>("GET", `/agents/${id}/transcript?from=${cursor}`);
			if (status === "running" && t.status !== "running") {
				// The run just ended: replace the live copy with the stored one.
				const full = await api<{ events: Event[]; next: number }>("GET", `/agents/${id}/transcript?from=0`);
				events = full.events;
				cursor = full.next;
			} else {
				events = [...events, ...t.events];
				cursor = t.next;
			}
			status = t.status;
			loaded = true;
			if (status !== "running") stop();
		} catch {
			loaded = true;
		}
	}, 1500);
	onDestroy(() => stop());

	// Claude Code-style live feedback while running: spinner glyph, rotating verb, elapsed seconds.
	const glyphs = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
	const verbs = ["Thinking", "Pondering", "Reasoning", "Tinkering", "Cooking", "Weaving", "Mulling"];
	let tick = $state(0);
	const timer = setInterval(() => tick++, 100);
	onDestroy(() => clearInterval(timer));
	const elapsed = $derived.by(() => {
		tick;
		const s = Math.max(0, Math.floor((Date.now() - (run?.started ?? Date.now())) / 1000));
		return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
	});
	const live = $derived((run?.status ?? status) === "running");

	// One scrollable box; follow new output unless the reader has scrolled up.
	let box = $state<HTMLElement>();
	let pinned = true;
	const onscroll = () => (pinned = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 24);
	$effect(() => {
		events.length;
		if (live && pinned) nextTick().then(() => box?.scrollTo({ top: box.scrollHeight }));
	});

	const init = $derived(events.find((e) => e.type === "system" && e.subtype === "init"));
	const result = $derived(events.findLast((e) => e.type === "result"));
	const blocks = (e: Event): Block[] => (Array.isArray(e.message?.content) ? e.message.content : typeof e.message?.content === "string" ? [{ type: "text", text: e.message.content }] : []);
	// A tool result's content: a string, or text blocks.
	const output = (c: unknown) =>
		typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string; type?: string }) => x.text ?? `[${x.type}]`).join("\n") : JSON.stringify(c, null, 2);
	const json = (x: unknown) => JSON.stringify(x, null, 2);
	const hookContext = (o?: string) => {
		try {
			return JSON.parse(o ?? "").hookSpecificOutput?.additionalContext ?? "";
		} catch {
			return "";
		}
	};
</script>

<header class="head">
	<p class="kind muted">{[kind, init?.model].filter(Boolean).join(" · ")}</p>
	<h1>{run?.prompt.split("\n")[0] ?? id}</h1>
	<p class="muted">
		<i class="dot {status === 'running' ? 'working pulse' : status === 'failed' || status === 'lost' ? 'conflict' : 'merged'}"></i>
		{[
			agentLabel(run?.status ?? status),
			run && (run.finished ? `took ${duration(run.finished - run.started)}` : `started ${ago(run.started)}`),
			result?.total_cost_usd && `$${result.total_cost_usd.toFixed(2)}`,
			result?.num_turns && `${result.num_turns} ${result.num_turns === 1 ? "turn" : "turns"}`,
		]
			.filter(Boolean)
			.join(" · ")}
	</p>
</header>

{#snippet spin()}
	<p class="thinking"><span class="glyph">{glyphs[tick % glyphs.length]}</span> {verbs[Math.floor(tick / 40) % verbs.length]}… <span class="muted">({elapsed})</span></p>
{/snippet}

{#if !loaded}
	<p class="muted">Loading…</p>
{:else if !events.length}
	<p class="muted">{status === "running" ? "The agent is starting. Its transcript shows up here as it works." : "No transcript was kept for this run."}</p>
	{#if live}{@render spin()}{/if}
{:else}
	<div class="box" bind:this={box} {onscroll}>
	<ol class="events">
		{#each events as e, i (i)}
			{#if e.type === "assistant"}
				{#each blocks(e) as b}
					{#if b.type === "text" && b.text?.trim()}
						<li class="text"><Markdown text={b.text} /></li>
					{:else if b.type === "thinking"}
						<li><details><summary>Thinking</summary>{#if b.thinking}<pre class="thought">{b.thinking}</pre>{:else}<p class="muted pad">Its thinking isn't shown.</p>{/if}</details></li>
					{:else if b.type === "tool_use"}
						<li><details><summary><span class="tool">{b.name}</span> <span class="muted">{typeof (b.input as { description?: string })?.description === "string" ? (b.input as { description: string }).description : ""}</span></summary><pre>{json(b.input)}</pre></details></li>
					{/if}
				{/each}
			{:else if e.type === "user"}
				{#each blocks(e) as b}
					{#if b.type === "tool_result"}
						<li><details><summary class:error={b.is_error}>{b.is_error ? "Tool error" : "Tool result"}</summary><pre>{output(b.content)}</pre></details></li>
					{/if}
				{/each}
			{:else if e.type === "system" && e.subtype === "hook_response" && hookContext(e.output)}
				<li><details><summary>Memory update ({e.hook_event})</summary><pre>{hookContext(e.output)}</pre></details></li>
			{:else if e.type === "result"}
				<li class="result" class:error={e.is_error}>
					<strong>{e.is_error ? "Ended with an error" : "Finished"}</strong>
					{#if e.result}<Markdown text={e.result} />{/if}
				</li>
			{:else if e.type === "truncated"}
				<li class="muted">An event of {Math.round((e.bytes ?? 0) / 1000)} KB was too big to keep.</li>
			{:else if e.type === "raw" && e.text}
				<li><pre>{e.text}</pre></li>
			{/if}
		{/each}
	</ol>
	{#if live}
		{@render spin()}
	{/if}
	</div>
{/if}

{#if run?.log}
	<details class="log"><summary>Sandbox log</summary><pre>{run.log}</pre></details>
{/if}
<p class="back"><a href="/repos/{repo}/agents">All agents</a></p>

<style>
	.head { margin-bottom: 1.25rem; }
	.kind { font-size: 0.8125rem; text-transform: uppercase; letter-spacing: 0.04em; }
	.head h1 { margin: 0.2rem 0 0.4rem; overflow-wrap: anywhere; }
	.head .dot { vertical-align: 0.05em; margin-right: 0.2rem; }
	.box { max-height: calc(100vh - 15rem); min-height: 10rem; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-md); padding: 0.75rem; background: var(--paper); }
	.events { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.5rem; }
	.events li { min-width: 0; }
	.text :global(.md) { padding: 0.25rem 0; }
	details { border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--raised); }
	summary { cursor: pointer; padding: 0.45rem 0.75rem; font-size: 0.875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	summary.error { color: var(--conflict); }
	.tool { font-family: var(--mono); font-weight: 600; }
	pre { margin: 0; padding: 0.6rem 0.75rem; border-top: 1px solid var(--line-2); white-space: pre-wrap; font-size: 0.75rem; }
	.thought { font-style: italic; color: var(--ink-2); }
	.pad { padding: 0.5rem 0.75rem; }
	.result { border-left: 3px solid var(--merged); padding-left: 0.9rem; margin-top: 0.5rem; }
	.result.error { border-color: var(--conflict); }
	.result :global(.md) { padding: 0.4rem 0; }
	.thinking { margin-top: 0.75rem; font-size: 0.875rem; color: var(--ink-2); }
	.glyph { display: inline-block; width: 1em; font-family: var(--mono); color: var(--ink); }
	.log { margin-top: 1.5rem; }
	.back { margin-top: 1.5rem; }
</style>
