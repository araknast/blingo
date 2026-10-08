<script lang="ts" module>
	export type MenuItem = { label: string; action: () => void; danger?: boolean };
</script>

<script lang="ts">
	let { x, y, items, title, onclose }: { x: number; y: number; items: MenuItem[]; title?: string; onclose: () => void } = $props();

	let el: HTMLDivElement;
	let w = $state(0);
	let h = $state(0);
	// Keep the whole menu on screen.
	const left = $derived(Math.max(8, Math.min(x, innerWidth - w - 8)));
	const top = $derived(Math.max(8, Math.min(y, innerHeight - h - 8)));

	const buttons = () => [...el.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];

	$effect(() => {
		const back = document.activeElement as HTMLElement | null;
		buttons()[0]?.focus();
		const away = (e: Event) => !el.contains(e.target as Node) && onclose();
		const close = () => onclose();
		addEventListener("pointerdown", away, true);
		addEventListener("scroll", close, true);
		addEventListener("resize", close);
		return () => {
			removeEventListener("pointerdown", away, true);
			removeEventListener("scroll", close, true);
			removeEventListener("resize", close);
			// Return focus unless an action moved it on (e.g. into a dialog).
			const now = document.activeElement;
			if (!now || now === document.body || el.contains(now)) back?.focus?.({ preventScroll: true });
		};
	});

	function key(e: KeyboardEvent) {
		const bs = buttons();
		const i = bs.indexOf(document.activeElement as HTMLButtonElement);
		const go = (j: number) => (e.preventDefault(), bs[(j + bs.length) % bs.length].focus());
		if (e.key === "ArrowDown") go(i + 1);
		else if (e.key === "ArrowUp") go(i - 1);
		else if (e.key === "Home") go(0);
		else if (e.key === "End") go(bs.length - 1);
		else if (e.key === "Escape" || e.key === "Tab") (e.preventDefault(), onclose());
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="menu"
	role="menu"
	tabindex="-1"
	aria-label={title ?? "Actions"}
	bind:this={el}
	bind:clientWidth={w}
	bind:clientHeight={h}
	style="left:{left}px;top:{top}px"
	onkeydown={key}
	oncontextmenu={(e) => e.preventDefault()}
>
	{#if title}<p class="title">{title}</p>{/if}
	{#each items as item}
		<button role="menuitem" class:danger={item.danger} onclick={() => (onclose(), item.action())}>{item.label}</button>
	{/each}
</div>

<style>
	.menu {
		position: fixed;
		z-index: 50;
		min-width: 15rem;
		padding: 0.3rem;
		background: var(--raised);
		border: 1px solid var(--line);
		border-radius: var(--r-md);
		box-shadow: 0 10px 30px rgb(15 24 33 / 0.18);
		animation: pop 110ms ease-out;
	}
	@keyframes pop { from { opacity: 0; transform: scale(0.97); } }
	.title { font-size: 0.75rem; color: var(--ink-3); padding: 0.35rem 0.65rem 0.3rem; }
	.title + button { margin-top: 0.1rem; }
	button {
		display: flex;
		width: 100%;
		border: 0;
		background: none;
		padding: 0.45rem 0.65rem;
		border-radius: var(--r-sm);
		font-size: 0.875rem;
		font-weight: 400;
		text-align: left;
	}
	button:hover, button:focus-visible { background: var(--line-2); outline: none; }
	.danger { color: var(--conflict); }
</style>
