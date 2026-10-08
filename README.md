# blingo

Agent-based change control on Cloudflare. Agents (or a human, through a "notagent") work on
forks of a repository; blingo groups finished forks into **bubbles** of forks that touch disjoint
files, and a background loop merges everything back together. See [design.md](design.md) for the
idea and [ARCHITECTURE.md](ARCHITECTURE.md) for how it is built.

## Layout

| Path | What |
|---|---|
| `backend/` | **blingo** — the Worker: API, bubble logic, merge loop, sandboxes (Durable Objects + Containers + Artifacts) |
| `yorkle/` | **yorkle** — the web UI: static page + a tiny Worker that forwards API calls to blingo |
| `design.md` | Original design sketch |

npm workspaces: run `npm install` once at the root.

## Setup (once per Cloudflare account)

1. `npx wrangler login`
2. Create the Artifacts namespace `blingo` (REST: `POST /accounts/:id/artifacts/namespaces {"namespace":"blingo"}`; wrangler has no create command).
3. Secrets on the `blingo` Worker:
   ```sh
   cd backend
   openssl rand -hex 32                     # your API token; keep it
   npx wrangler secret put BLINGO_TOKEN
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
4. Docker with buildx (needed to build the sandbox image). On Debian's `docker.io` 20.10, install
   `docker-buildx-plugin` from Docker's apt repo and run `docker buildx install`.

## Develop

```sh
npm test            # bubble logic unit tests (backend)
npm run check       # typecheck both projects
npm run dev         # yorkle + blingo together; open the printed URL
```

`backend/.dev.vars` holds local secrets (`BLINGO_TOKEN=dev`). Add `--enable-containers=false` to
`wrangler dev` to run without Docker (git/agent features then fail). To use real Artifacts in
local dev, add `"remote": true` to the `artifacts` binding in `backend/wrangler.jsonc`.

After changing a `wrangler.jsonc`, run `npm run types -w backend` / `-w yorkle`.

## Deploy

```sh
npm run deploy      # blingo first (yorkle binds to it), then yorkle
```

- UI: `https://yorkle.<subdomain>.workers.dev`
- API: same origin through yorkle, or directly at `https://blingo.<subdomain>.workers.dev`

## API

All requests need `Authorization: Bearer $BLINGO_TOKEN`. Any request can return `503` with
`Retry-After` when Artifacts fails transiently (e.g. many parallel forks); retry it.

| Method & path | Does |
|---|---|
| `POST /agents {prompt, repo?, bubble?}` | Fork and run Claude Code on it. No `repo` → new repository; no `bubble` → any bubble |
| `POST /notagents {repo?, bubble?}` | Fork and return a one-push git remote; the push gets placed |
| `GET /agents/:fork` | One agent's sandbox status and log tail |
| `GET /repos/:repo` | Bubbles, members, conflicts, notagents waiting for a push (`waiting`) or pushed and being placed (`placing`), agent runs |
| `GET /repos/:repo/:fork` | Kept diff of a merged fork |
| `GET /repos/:repo/:fork?path=…` | A file as that fork sees it |
| `DELETE /repos/:repo` | Delete the repository's git repos and all its records |
| `POST /repos/:repo/lock {bubble}` / `…/unlock {bubble}` | Lock or unlock a bubble (locked: no bubble merges) |
| `POST /repos/:repo/ferge {a, b}` | Ferge two conflicting bubbles → `{bubble, locked, files}` |
