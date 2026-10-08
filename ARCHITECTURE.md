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
| Worker | `backend/src/index.ts` | Auth (session or `BLINGO_TOKEN`), repo-ownership checks, routing, creating repos/forks, minting git tokens |
| UsersDO | `backend/src/users-do.ts`, `backend/src/auth.ts` | One global SQLite object: accounts, pending signups, invites, sessions, repo owners |
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
| `conflict(k)` | `"a|b"` bubble pairs whose merge failed; never retried (except by a ferge). When a bubble is absorbed, its pairs move to the bubble that absorbed it |
| `locked(id)` | locked bubbles: placeable, but excluded from neighbour merges and distance-0 joins |
| `hidden(id, since)` | lease for a bubble hidden by a running merge or ferge (see Merge loop) |
| `watch(fork, base, token, expires)` | notagent forks waiting for their push, or pushed and not yet placed |
| `pushed(fork)` | watched forks whose push arrived; removed with the watch once placed |
| `agent_run(fork, prompt, started, status, finished, log)` | agent runs, kept after they finish |

Some older RepoDOs also have an unused `fork.deleted` column, so inserts name their columns.

## UsersDO tables

| Table | Holds |
|---|---|
| `user(name, email, hash, salt, created)` | verified accounts; PBKDF2-SHA256 password hashes |
| `pending(token, name, email, hash, salt, invite, expires)` | signups waiting for their emailed link (24 h) |
| `invite(code, created, used_by)` | single-use codes minted by the admin |
| `session(token, name, expires)` | 30-day bearer tokens |
| `repo(name, owner)` | who created each repository |

## Flows

**Signup.** `POST /signup` checks the invite is unused and the name and email are free, stores a
`pending` row and emails `/verify?token=…` via the `EMAIL` (`send_email`) binding. `GET /verify`
re-checks all three (another signup on the same invite may have won), then creates the user,
spends the invite and drops the competing pending rows. The admin is whichever user is named
`ADMIN_USERNAME`; `BLINGO_TOKEN` also acts as that account, which is how the first invite is made.

**Placement** (`RepoDO.place`, `PLACE_SH`). One Box job checks the visible bubbles in order. For
each, it computes the files the fork would bring into that bubble's rep (`git diff` since their
merge base), so history the fork carries from elsewhere counts too, and stops at the first bubble
none of whose files are in that set. The fork joins it, recorded with that set, so it can always be
merged in. If that bubble changed while the job ran, placement runs again. If
none fits, it starts a new bubble as its representative, with its files = everything changed since
the repository's starting point (the empty tree), so distance to other bubbles reflects all it
carries. Then any visible bubbles at
distance 0 are set-joined: the absorbed bubble's members move over and its rep becomes a `pending`
member, so its code is still merged in.

**Notagent.** `POST /notagents` forks, mints a 1-hour write token, and registers a `watch`. The
alarm checks each watched fork's head every 5 s (`repo.log`, all in parallel). On change it revokes
the token and marks the fork `pushed`. Then it places every pushed fork **in parallel**: `place()`
re-checks its chosen bubble right before inserting, so concurrent placements stay safe. The watch is
kept until placement succeeds, so failures are retried. Unpushed forks are deleted when the token
expires. The API reports `waiting` (no push yet) and `placing` (pushed, not yet placed) separately.

**Agent.** `POST /agents` forks and calls `Box.startAgent`: clone, `claude --print …`, commit,
push, all detached in the container. The Box alarm checks every 30 s. When
it's done it places the fork (or deletes it on failure) and reports to `RepoDO.agentDone`.

**Merge loop** (`RepoDO.alarm`, one step per tick, running **concurrently with placement**):
1. Every visible bubble with `pending` members merges all of them (up to 50) into its rep in one
   `MERGE_SH` job: a single merge commit, an octopus when there are several. If that fails, the
   job merges them one at a time, so only the members that conflict are marked `conflict`; the
   rest become `merged`, with their diffs kept and their repos deleted. All such bubbles run in
   parallel.
2. Else pick a visible bubble and its nearest non-conflicting neighbour; hide both; merge the
   neighbour's rep into this rep with a merge commit. On success, join the sets and delete the
   neighbour's rep; on conflict, record the pair. Show both again and re-run zero-distance joins.

Running alongside placement is safe: `place()` re-checks its bubble before inserting, members
placed during a batch wait for the next one, and step 2 hides both bubbles before its git work.
Infra errors throw; the alarm retries. Only a merge conflict counts as a conflict.

**Hidden bubbles are leased.** Hiding records the time in `hidden(id, since)`. If the operation
dies first (cancelled alarm, reset, deploy), its bubbles would stay hidden, blocking merges and
ferges on them. So every alarm run and every ferge first un-hides bubbles hidden for over 15 min
(the alarm's own wall-clock limit; real merges take seconds). A fresh object instance un-hides all
of them, since nothing from the old instance is still running.
Locked bubbles skip step 2 on both sides, but their own pending members are still merged in.

**Lock / unlock** (`POST /repos/:repo/lock|unlock`). Unlocking re-runs distance-0 joins and
wakes the merge loop.

**Ferge** (`POST /repos/:repo/ferge {a, b}`, `RepoDO.ferge`, `FERGE_SH`). Only for a pair in
`conflict`, both visible and unlocked; both are hidden while it runs. In a Box:
1. `git merge-tree` lists the files that conflict between the two reps.
2. A real `git merge` captures those files with conflict markers.
3. The files are removed from both sides, and b's changes land on a's rep as one squashed commit.
4. A new fork of a's rep gets a commit adding the marker files.

Then b is absorbed into a (its rep repo deleted), the conflict row goes, and the new fork becomes
a **locked** bubble. Its file set is everything in its tree (like any new bubble); the API returns
just the conflicting files. A fix forked from it goes wherever it fits like any fork; it doesn't
wait for the unlock, so it must resolve **every** conflicting file: any it misses reach the main
bubble with their conflict markers. Unlock the bubble to let it merge back.

## Sandbox and secrets

- Containers start with `enableInternet: false`; all HTTP(S) goes through `Outbound`. That allows
  `*.artifacts.cloudflare.net`, and adds `ANTHROPIC_API_KEY` to `api.anthropic.com` requests, so
  the key never enters the sandbox.
- Git auth is a short-lived, per-repo Artifacts token embedded in the remote URL.
- The API (apart from signup, verify, login) needs a session token or `BLINGO_TOKEN`, because it
  mints push tokens and starts paid runs. Repository routes also check the caller owns the repo.

## Known limits

Marked with `ponytail:` comments in the code.

- Neighbour merges run one at a time per repository. A ferge runs from its API request, not the
  alarm, so a member merge into the same rep at that moment makes one of them fail.
- Pushes are found by polling, not Artifacts events; several pushes within one 5 s window all
  count as the one push.
- Bubble rules are by file path only; semantic conflicts surface at merge or not at all.
- Agent runs are listed per repository; there is no cross-repository list.
- No rate limit on login or signup; no password reset, invite expiry or repo sharing.
