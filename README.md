# blingo

Agent-based change control on Cloudflare. Agents (or a human, through a "notagent") work on
forks of a repository; blingo groups finished forks into **bubbles** of forks that touch disjoint
files, and a background loop merges everything back together. See [design.md](design.md) for the
idea and [ARCHITECTURE.md](ARCHITECTURE.md) for how it is built.

## Layout

| Path | What |
|---|---|
| `backend/` | **blingo** — the Worker: API, bubble logic, merge loop, sandboxes (Durable Objects + Containers + Artifacts) |
| `yorkle/` | **yorkle** — the web UI: a Svelte app (live bubble map, code and commit browser) + a tiny Worker that forwards `/api/*` to blingo |
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
   ```
   blingo has no model API key of its own: each repository sets one in its settings before its
   agents can run.
   ```sh
   ```
4. Verification email: onboard the sender domain to Cloudflare Email Sending
   (`npx wrangler email sending enable blingo.breakdance.cc`). The sender (`EMAIL_FROM`) and the
   admin's username (`ADMIN_USERNAME`) are vars in `backend/wrangler.jsonc`.
5. After deploying, create the admin account: mint the first invite with the API token, then sign
   up as `ADMIN_USERNAME` in the UI (before anyone else can take that name):
   ```sh
   curl -X POST -H "authorization: Bearer $BLINGO_TOKEN" https://blingo.<subdomain>.workers.dev/invites
   ```
6. Docker with buildx (needed to build the sandbox image). On Debian's `docker.io` 20.10, install
   `docker-buildx-plugin` from Docker's apt repo and run `docker buildx install`.

## Develop

```sh
npm test            # unit tests (backend, and yorkle's lib)
npm run check       # typecheck both projects
npm run dev         # builds yorkle, then runs yorkle + blingo together; open the printed URL
npm run dev:ui -w yorkle   # with `npm run dev` running: the UI on Vite with hot reload
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
- API: same origin through yorkle under `/api`, or directly at `https://blingo.<subdomain>.workers.dev`

## API

Signup is invite-only: `POST /signup` emails a link, and the account exists only once
`GET /verify` is opened. Every other request needs `Authorization: Bearer <token>`: a session
token from `POST /login`, or `$BLINGO_TOKEN`, which acts as the admin account. Each repository
belongs to the user who created it; other users get `404` for it (the admin sees all). Repositories
created before users existed have no owner, so only the admin can reach them. Any request can return `503` with
`Retry-After` when Artifacts fails transiently (e.g. many parallel forks); retry it.

| Method & path | Does |
|---|---|
| `POST /signup {invite, username, email, password}` | No auth. Emails a verification link (valid 24 h) |
| `GET /verify?token=…` | No auth. Creates the account and spends the invite |
| `POST /login {username, password}` → `{token, username, admin}` | No auth. Session token valid 30 days |
| `POST /logout` | End this session |
| `GET /me` | `{username, admin, repos, names}` (`names`: repository id → display name) |
| `POST /invites` → `{code}` | Admin only. A single-use invite code |
| `POST /repos {name?}` → `{repo}` | A new, empty repository with a display name |
| `POST /agents {prompt, repo, bubble?, model?}` | Fork and run Claude Code on it. The repository must have an API key (else 400). No `bubble` → any bubble; `model` overrides the repository's agent model for this run. With task approval on → `{task, awaitingApproval: true}` |
| `PATCH /repos/:repo/tasks/:id {title?, description?}` / `POST …/approve` / `POST …/reject` | Edit, approve, or reject (delete) a task awaiting approval; reject refuses while another task depends on it |
| `POST /notagents {repo?, bubble?}` | Fork and return a git remote with a 1-hour push token; a push gets placed (or waits as a loose fork when `autoPlaceNotagents` is off) |
| `GET /agents/:fork` | One agent's sandbox status and log tail |
| `GET /agents/:fork/transcript` | `{status, events}`: the run's Claude Code stream-json events (thinking, text, tool calls and results) |
| `GET /repos/:repo` | Bubbles, members, conflicts, bubbles merging, notagents waiting for a push (`waiting`), being placed (`placing`) or pushed and not placed (`loose`), settings, agent runs |
| `GET /repos/:repo/settings` / `PUT … {autoPlaceNotagents?, ci?: {enabled?, command?, hosts?}, review?, maxAgentPushes?, provider?, models?: {agent?, superagent?, ferge?}, apiKey?}` | Repository settings. `review`: none / auto / manual / both; `provider`: anthropic / openrouter; `fergeAgents`, `taskApproval`: booleans; `apiKey` is write-only (`"" ` removes it; `hasKey` says whether one is set) |
| `POST /repos/:repo/forks/:fork/place` | Place a loose notagent fork |
| `POST /repos/:repo/forks/:fork/token` | A fresh 1-hour push token for a notagent's loose fork |
| `POST /repos/:repo/forks/:fork/review {approve, comment?}` | A manual review of a loose fork waiting for one |
| `GET /repos/:repo/:fork` | Kept diff of a merged fork |
| `GET /repos/:repo/:fork?path=…` | A file as that fork sees it |
| `DELETE /repos/:repo` | Delete the repository's git repos and all its records |
| `POST /repos/:repo/lock {bubble}` / `…/unlock {bubble}` | Lock or unlock a bubble (locked: no bubble merges) |
| `POST /repos/:repo/ferge {a, b}` | Ferge two conflicting bubbles → `{bubble, locked, files}` |
| `POST /repos/:repo/ferge/:bubble/resolve {files: {path: content}}` | Commit a person's resolution of a locked ferge bubble as a notagent fork of it and ask for its placement → `{task, fork, placing}` |
