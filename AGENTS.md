# Notes for coding agents

Read [README.md](README.md) for setup and [ARCHITECTURE.md](ARCHITECTURE.md) before changing behaviour.

## Projects

- `backend/` — the `blingo` Worker. Bubble rules live in `src/bubbles.ts` as pure functions; keep
  them I/O-free and add a test in `test/bubbles.test.ts` when you change them. The git jobs Boxes
  run are bash strings in `src/git-scripts.ts`; `test/git-scripts.test.ts` runs them against local
  repos (needs git ≥ 2.38), so extend it when you change one.
- `yorkle/` — the UI: a Svelte 5 + Vite app in `app/` (`routes/` pages, `lib/` shared parts;
  `lib/BubbleMap.svelte` is the live map) built to `dist/`. The client calls `/api/*`; the Worker
  (`src/index.ts`) strips `/api` and forwards to blingo. Put API logic in the backend, not here.
  `npm run dev:ui -w yorkle` serves the app with hot reload against `npm run dev` on :8787.

## Commands (repo root)

```sh
npm test         # unit tests (backend, and yorkle's lib)
npm run check    # typecheck both projects
npm run dev      # both Workers locally (needs Docker+buildx; add --enable-containers=false without)
npm run deploy   # deploys blingo, then yorkle
```

Run `npm run types -w <project>` after editing a `wrangler.jsonc`.

## Rules

- Never ship the API without the `BLINGO_TOKEN` check, and never put real secrets inside the
  sandbox: credentials are added by `Outbound` in `backend/src/box.ts`.
- RepoDO schemas are live data. Add tables with `CREATE TABLE IF NOT EXISTS`; when changing an
  existing table, migrate it in place and use named-column `INSERT`s.
- Keep `blingo` as the backend Worker name: secrets, Durable Objects and yorkle's service binding
  all refer to it.
- Don't commit `backend/.dev.vars`.

## Gotchas

- `wrangler artifacts repos delete` cancels when it can't prompt; use the REST API or `DELETE /repos/:repo`.
- Wrangler has no command for creating an Artifacts namespace; use the REST API.
- Container builds need Docker buildx; on Docker 20.10, run `docker buildx install`.
- `git push` to an Artifacts fork must target `HEAD:main`.
- The sandbox image pins Claude Code (`backend/Dockerfile`); bump it deliberately, since its
  flags and output format change between releases.
