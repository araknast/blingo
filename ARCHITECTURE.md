# Architecture

```
browser ──► yorkle Worker ──(service binding)──► blingo Worker ──► RepoDO (one per repository)
            static UI                            API + auth          │  bubbles, merge loop
                                                     │               ▼
                                                     └──────────► Box (Durable Object + container)
                                                                     git / Claude Code sandbox
                                         Cloudflare Artifacts (namespace "blingo") = every git repo
```

## Pieces

| Piece | File | Role |
|---|---|---|
| yorkle | `yorkle/src/index.ts`, `yorkle/public/index.html` | Serves the page; forwards every other path to blingo, so the API is same-origin |
| Worker | `backend/src/index.ts` | Bearer-token check, routing, creating repos/forks, minting git tokens |
| Bubble rules | `backend/src/bubbles.ts` | Pure functions: `placeFork`, `distance`, `zeroDistanceJoins`, `nearestNeighbour`. Unit-tested |
| RepoDO | `backend/src/repo-do.ts` | SQLite state for one repository; serializes placement and merging; alarm = representative loop |
| Box | `backend/src/box.ts` | Container sandbox. Runs git scripts for RepoDO and Claude Code for agents. `Outbound` limits its egress |
| Artifacts | binding `ARTIFACTS` | Hosts the base repo, every fork, and every bubble representative as real git remotes |

## Names

- Repository `r-xxxxxxxx` = an Artifacts repo (the empty starting point) + one RepoDO keyed by that name.
- Fork `r-xxxxxxxx-f-yyyyyyyy` = an Artifacts repo forked from the base or a bubble representative.
- Bubble id = the name of its **representative** fork (the first fork placed in it). The rep's repo holds the bubble's merged code.

## RepoDO tables

| Table | Holds |
|---|---|
| `bubble(id, visible, seq)` | `visible = 0` while it is in a neighbour merge (hidden from placement) |
| `fork(name, bubble, status, files, diff)` | status `rep` / `pending` / `merged` / `conflict`; `files` = changed paths (JSON); `diff` kept after merge |
| `conflict(k)` | `"a|b"` bubble pairs whose merge failed; never retried |
| `watch(fork, base, token, expires)` | notagent forks waiting for their push |
| `agent_run(fork, prompt, started, status, finished, log)` | agent runs, kept after they finish |

Some older RepoDOs also have an unused `fork.deleted` column, so inserts name their columns.

## Flows

**Placement** (`RepoDO.place`). A finished fork joins the first visible bubble whose files it
doesn't touch, otherwise it starts a new bubble as its representative. Then any visible bubbles at
distance 0 are set-joined: the absorbed bubble's members move over and its rep becomes a `pending`
member, so its code is still rebased in.

**Notagent.** `POST /notagents` forks, mints a 1-hour write token, and registers a `watch`. The
alarm checks each watched fork's head every 5 s (`repo.log`). On change it revokes the token,
computes changed files in a Box (`git diff --name-only`), and places the fork. Unpushed forks are
deleted when the token expires.

**Agent.** `POST /agents` forks and calls `Box.startAgent`: clone, `claude --print …`, commit,
push, write changed files, all detached in the container. The Box alarm checks every 30 s. When
it's done it places the fork (or deletes it on failure) and reports to `RepoDO.agentDone`.

**Merge loop** (`RepoDO.alarm`, one step per tick):
1. If any visible bubble has a `pending` member → rebase it onto the rep (`REBASE_SH`), mark it
   `merged`, keep its diff, delete its repo.
2. Else pick a visible bubble and its nearest non-conflicting neighbour; hide both; rebase the
   neighbour's rep onto this rep. On success, join the sets and delete the neighbour's rep; on
   conflict (exit 10), record the pair. Show both again and re-run zero-distance joins.

Infra errors throw; the alarm retries. Only a rebase conflict counts as a conflict.

## Sandbox and secrets

- Containers start with `enableInternet: false`; all HTTP(S) goes through `Outbound`. That allows
  `*.artifacts.cloudflare.net`, and adds `ANTHROPIC_API_KEY` to `api.anthropic.com` requests, so
  the key never enters the sandbox.
- Git auth is a short-lived, per-repo Artifacts token embedded in the remote URL.
- `BLINGO_TOKEN` guards the whole API, because it mints push tokens and starts paid runs.

## Known limits

Marked with `ponytail:` comments in the code.

- One merge at a time per repository (the alarm is single-flight).
- Pushes are found by polling, not Artifacts events; several pushes within one 5 s window all
  count as the one push.
- Bubble rules are by file path only; semantic conflicts surface at rebase or not at all.
- Agent runs are listed per repository; there is no cross-repository list.
