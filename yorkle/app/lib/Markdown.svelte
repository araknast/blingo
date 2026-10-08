<script lang="ts">
	import DOMPurify from "dompurify";
	import { marked } from "marked";

	let { text }: { text: string } = $props();
	// ponytail: relative links and images inside the file aren't rewritten to the code browser.
	const html = $derived(DOMPurify.sanitize(marked.parse(text, { async: false })));
</script>

<div class="md">{@html html}</div>

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
