<script lang="ts">
	import { onDestroy } from "svelte";
	import { fade } from "svelte/transition";
	import BubbleMap from "../lib/BubbleMap.svelte";
	import { demoSteps } from "../lib/demo";

	// The demo plays its steps, then crossfades into a fresh map at step 0, so the loop never jumps.
	const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
	let step = $state(reduced ? demoSteps.length - 1 : 0);
	let cycle = $state(0);
	const timer = reduced
		? 0
		: setInterval(() => {
				if (step < demoSteps.length - 1) step++;
				else ((step = 0), cycle++);
			}, 2200);
	onDestroy(() => clearInterval(timer));
</script>

<div class="splash">
	<header>
		<span class="wordmark">yorkle</span>
	</header>
	<section class="intro">
		<h1>Run many coding agents on one repository.</h1>
		<p class="lede">yorkle sorts their forks into bubbles by the files they change, and merges each bubble as it goes.</p>
		<div class="cta">
			<a class="button light" href="/login">Log in</a>
			<a class="button outline" href="/signup">Sign up</a>
		</div>
		<p class="invite">Signing up needs an invite code from someone who already uses yorkle.</p>
	</section>
	<figure class="stage">
		<div class="map-wrap">
			{#key cycle}
				<div class="map-layer" transition:fade={{ duration: 700 }}><BubbleMap data={demoSteps[step]} demo /></div>
			{/key}
		</div>
	</figure>
</div>

<style>
	.splash {
		--ink: #e4eaf0;
		--ink-2: #b2bfcb;
		--ink-3: #8595a4;
		--paper: #1c2834;
		--raised: #22303e;
		--line: #33434f;
		--line-2: #2a3845;
		--merged: #4fb3a5;
		--pending: #8595a4;
		--conflict: #e06a4e;
		--working: #e0a338;
		min-height: 100dvh;
		display: grid;
		grid-template-columns: minmax(20rem, 34rem) 1fr;
		grid-template-rows: auto 1fr;
		background: var(--harbor);
		color: var(--ink);
		overflow: hidden;
	}
	.splash :global(.map) {
		--fog: transparent; /* the map's dots on the splash's own background */
		--soap-core: rgb(255 255 255 / 0.1);
		--soap-mid: rgb(255 255 255 / 0.03);
		--soap-edge: rgb(185 163 240 / 0.14);
	}
	@media (prefers-color-scheme: light) {
		.splash { --harbor: #1d2b3a; }
	}
	header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; padding: 1.5rem clamp(1rem, 4vw, 3.5rem); }
	.wordmark { font-weight: 700; font-size: 1.75rem; letter-spacing: -0.045em; color: #fff; }
	.intro { padding: clamp(2rem, 8vh, 6rem) 0 3rem clamp(1rem, 4vw, 3.5rem); align-self: start; }
	h1 {
		font-size: clamp(2.25rem, 4.6vw, 3.75rem);
		line-height: 1.04;
		letter-spacing: -0.035em;
		font-weight: 700;
		color: #fff;
		max-width: 11ch;
	}
	.lede { margin-top: 1.5rem; font-size: 1.125rem; line-height: 1.55; color: var(--ink-2); max-width: 30rem; }
	.cta { margin-top: 2.25rem; display: flex; gap: 0.75rem; }
	.cta .button { padding: 0.7rem 1.4rem; font-size: 1rem; }
	.light { background: #fff; border-color: #fff; color: #0f1821; }
	.light:hover { background: var(--teal); border-color: var(--teal); }
	.outline { background: transparent; border-color: rgb(255 255 255 / 0.35); color: #fff; }
	.outline:hover { border-color: #fff; }
	.invite { margin-top: 1rem; font-size: 0.875rem; color: var(--ink-3); }

	.stage { margin: 0; display: flex; flex-direction: column; min-height: 0; padding: 0 clamp(1rem, 3vw, 2.5rem) 2rem 1rem; }
	.map-wrap { flex: 1; min-height: 22rem; position: relative; border-radius: var(--r-md); overflow: hidden; }
	.map-layer { position: absolute; inset: 0; }

	@media (max-width: 900px) {
		.splash { grid-template-columns: 1fr; grid-template-rows: auto auto 1fr; overflow: visible; }
		.intro { padding-right: 1rem; padding-top: 1rem; }
		.stage { padding: 0 1rem 1.5rem; }
		.map-wrap { min-height: 52vh; }
	}
</style>
