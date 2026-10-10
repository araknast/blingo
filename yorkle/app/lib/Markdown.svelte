<script lang="ts">
	import DOMPurify from "dompurify";
	import { marked } from "marked";
	import { onDestroy } from "svelte";
	import { file } from "./git";

	// src: where the file lives, so its relative images load from the code browser (the API needs the
	// Bearer header, so they're fetched and shown as object URLs).
	let { text, src }: { text: string; src?: { repo: string; bubble: string; dir: string; at?: string } } = $props();
	// ponytail: relative links inside the file aren't rewritten to the code browser.
	const html = $derived(DOMPurify.sanitize(marked.parse(text, { async: false })));

	let el = $state<HTMLDivElement>();
	let urls: string[] = [];
	onDestroy(() => urls.forEach(URL.revokeObjectURL));

	$effect(() => {
		void html;
		if (!el || !src) return;
		const { repo, bubble, dir, at } = src;
		for (const img of el.querySelectorAll("img")) {
			const s = img.getAttribute("src");
			if (!s || /^([a-z][\w+.-]*:|\/)/i.test(s)) continue; // absolute URL, data:, or site path
			const path = decodeURIComponent(new URL(s, `x:/${dir ? dir + "/" : ""}`).pathname.slice(1));
			img.removeAttribute("src");
			file(repo, bubble, path, at)
				.then((b) => (urls.push(URL.createObjectURL(b)), (img.src = urls.at(-1)!)))
				.catch(() => (img.alt ||= path));
		}
	});
</script>

<div class="md" bind:this={el}>{@html html}</div>

<style>
	.md { padding: 1.5rem 2rem; max-width: 52rem; line-height: 1.65; overflow-wrap: anywhere; }
	.md :global(h1), .md :global(h2) { margin: 1.5rem 0 0.75rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--line-2); }
	.md :global(h1:first-child), .md :global(h2:first-child) { margin-top: 0; }
	.md :global(h3) { margin: 1.25rem 0 0.5rem; }
	.md :global(p), .md :global(ul), .md :global(ol) { margin: 0 0 1rem; }
	.md :global(code) { background: var(--fog); padding: 0.1rem 0.3rem; border-radius: 3px; }
	.md :global(pre) { background: var(--fog); padding: 0.9rem 1rem; border-radius: var(--r-sm); overflow-x: auto; }
	.md :global(pre code) { background: none; padding: 0; }
	.md :global(img) { max-width: 100%; }
	.md :global(blockquote) { margin: 0 0 1rem; padding-left: 1rem; border-left: 3px solid var(--line); color: var(--ink-2); }
	.md :global(table) { border-collapse: collapse; margin-bottom: 1rem; }
	.md :global(th), .md :global(td) { border: 1px solid var(--line); padding: 0.3rem 0.6rem; }
</style>
