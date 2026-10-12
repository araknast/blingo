# Bubble map at scale

A browser simulation of the Overview map with hundreds to thousands of agents on one repository.
`engine.cjs` reimplements blingo's rules without I/O: `placeFork` placement, per-bubble patch
queues, the parallel neighbour merge loop (`MAX_MERGES` in `repo-do.ts`) with auto-ferge in its free
slots, ferge agents (which never fail here, so a stopped repository settles to one bubble), and the CI
gate with fixers. `ui.html` draws yorkle's map (`app/lib/BubbleMap.svelte`) on a canvas.

```sh
node yorkle/sim/build.mjs   # writes yorkle/sim/dist/orchard-at-scale.html; open it in a browser
node yorkle/sim/check.cjs   # sanity checks on the engine
```

The engine is a copy of the rules, not the rules: when `backend/src/bubbles.ts` or the merge loop
in `repo-do.ts` changes, update `engine.cjs` to match. The numbers it produces are illustrative.
