# Architecture

```
browser ──► yorkle Worker ──(service binding)──► blingo Worker ──► RepoDO (one per repository)
            static UI                            API + auth          │  bubbles, patch queues
                                                     │               ▼
                                                     └──────────► Box (Durable Object + container)
                                                                     one per agent: Claude Code
                                                                     one per bubble: its rep's clone
                                         Cloudflare Artifacts (namespace "blingo") = every git repo
```

## Pieces

| Piece | File | Role |
|---|---|---|
| yorkle | `yorkle/src/index.ts`, `yorkle/app/` | Serves the built Svelte app (unknown paths get `index.html`); forwards `/api/*` (prefix stripped) and `/verify` to blingo, so the API is same-origin. A repository's views are tabs in the sidebar: Map (`/repos/:r`; bubbles, running agents as movable nodes, merging and conflict lines, a dock of forks not in a bubble yet), Tasks, Agents (runs and their transcripts, `/repos/:r/agents/:id`; its tab shows the number running, like Tasks' open count), Deploy, Skills, Memory, Settings; a loose fork has its own page (`/repos/:r/forks/:fork`) |
| Code browser | `backend/src/git.ts` | Pure tree helpers (`resolvePath`, `diffTrees`) behind `GET /repos/:r/:fork/tree`, `/log`, `/commits/:hash`, `/blob/:hash`. Unit-tested |
| Worker | `backend/src/index.ts` | Auth (session or `BLINGO_TOKEN`), repo-ownership checks, routing, creating repos/forks, minting git tokens |
| UsersDO | `backend/src/users-do.ts`, `backend/src/auth.ts` | One global SQLite object: accounts, pending signups, invites, sessions, repo owners |
| Skills rules | `backend/src/skills.ts` | Pure: `parseSkillUpload` (a picked folder → a skill, or why not), `resolveSkills` (which skills an agent loads). Unit-tested |
| Bubble rules | `backend/src/bubbles.ts` | Pure functions: `placeFork`, `distance`, `nearestNeighbour`. Unit-tested |
| RepoDO | `backend/src/repo-do.ts` | SQLite state for one repository: placement, each bubble's patch queue, neighbour merges; alarm = the loop that drives them |
| Box | `backend/src/box.ts`, `backend/src/git-scripts.ts` | Container sandbox. Runs Claude Code for an agent, or holds a bubble's rep clone and runs its git jobs (the git scripts are tested against local repos). `Outbound` limits its egress |
| Artifacts | binding `ARTIFACTS` | Hosts the base repo, every fork, and every bubble representative as real git remotes |

## Names

- Repository `r-xxxxxxxx` = an Artifacts repo (the empty starting point) + one RepoDO keyed by that name.
  Its display name (`POST /repos {name}`, else a friendly "adjective noun") is in UsersDO `repo.title`
  and the RepoDO's KV (`name`).
- Bubble names (`src/names.ts`): the repository's first bubble is called after the repository; later
  ones get a friendly "adjective noun"; a ferge bubble is called `<adj a> <adj b> <noun a><noun b> ferge`.
  A bubble keeps its name when it absorbs another.
- Fork `r-xxxxxxxx-f-yyyyyyyy` = an Artifacts repo forked from the base or a bubble representative.
- Bubble id = the name of its **representative** fork (the fork that started it). The rep's repo holds the bubble's code, and only the bubble's own Box (`bubble-<id>`) ever writes it.

## RepoDO tables

| Table | Holds |
|---|---|
| `bubble(id, visible, seq, epoch, ferge, name, adj, noun)` | `visible = 0` while it is in a neighbour merge or ferge (hidden from placement); `epoch` goes up when its code changes other than by applying a member's series (absorbing a bubble, a ferge); `ferge = 1` for a ferge's locked bubble |
| `fork(name, bubble, status, files, diff, seq)` | a member and its change table. status `rep` / `pending` (its patch series is queued) / `merged` (applied) / `failed` (its series didn't apply) / `conflict` (a fork from before patch series that didn't merge); `files` = paths it changed (JSON); `diff` = its patch series (mbox); `seq` = when it was applied, across the repository |
| `conflict(k)` | `"a|b"` bubble pairs whose merge failed; never retried (except by a ferge). When a bubble is absorbed, its pairs move to the bubble that absorbed it |
| `locked(id)` | locked bubbles: placeable, but excluded from neighbour merges |
| `hidden(id, since)` | lease for a bubble hidden by a running merge or ferge (see Merge loop) |
| `loose(fork, base, head, token, expires, pushes, placing, sub, reason, kind, ci, ci_log, review_auto, review_manual, review_note, agent_pushes)` | forks not placed yet (a notagent's, or with CI on an agent's): `base` = where it started, `head` = last seen, `token` = live push token id (NULL once revoked or expired), `placing`, `reason` = why it isn't placed. CI results are for `head`: `ci` running/passed/failed and its log tail, each review pending/approved/rejected (NULL = not required) and their comments; `agent_pushes` counts an agent's attempts. Replaces `watch`/`pushed` (emptied into it on startup). Some rows have an unused `sub` column |
| `agent_run(fork, prompt, started, status, finished, log)` | agent and superagent runs (`-s-` ids), kept after they finish |
| `task(id, title, description, kind, status, bubble, fork, base_head, explanation, superagent, created, finished)` | tasks: a short `title` (≤ 60 chars); `kind` agent / notagent; `skills` = JSON list of the skills its agent loads (NULL = all, added in place); `status` open / in-progress / completed / failed; `bubble` = where it should start, then where it did. Listed in `rowid` (creation) order. `title` was added in place: objects from before it get the column and titles from their descriptions on startup |
| `task_dep(task, dep)` | task dependencies |
| `memory(id, text, author, created)` | memory items, given to every agent and superagent |
| `skill(name, description, created)`, `skill_file(skill, path, data)` | the repository's skills; one row per file, `data` base64 (a skill is at most 1 MB, 200 files) |
| `deploy(id, name, bubble, head, status, started, finished, log, by)` | manual deployments: `status` running / succeeded / failed; `head` = the bubble's commit it ran on; `log` = output tail |
| `owed(locked, into)` | ferge debt: locked bubble `locked` still owes its conflicting files to bubble `into` |
| `basis(fork, bubble, epoch, seq)` | where an unplaced fork started: the bubble it was forked from (NULL = the base repo), that bubble's epoch, and the repository's last applied `seq`, read just before forking |
| `renamed(from, into)` | absorbed bubbles, so a fork's basis can be followed to the bubble that holds its code now |
| `merging(a, b)` | bubble pairs in a neighbour merge or ferge, for the map |

The repository's name is kept in the object's KV (`repo`), set by `addTasks`, so the alarm can start agents. The KV's `seq` counts applied series.

Some older RepoDOs also have an unused `fork.deleted` column, and columns were added in place since, so inserts name their columns.

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

**Placement** (`RepoDO.place`, `placeFork`). A fork never pushes to a bubble. When it is done, its
**patch series** (`git format-patch` of its commits: an mbox, as git send-email sends them) and its
**change table** (the files it changed since it started) go to `place()`. Each fork's starting point
is recorded in `basis` when it is made: the bubble it was forked from, that bubble's `epoch`, and the
last applied `seq`. `placeFork` takes the first visible bubble the series applies to cleanly, trying
the fork's home bubble first. A series applies cleanly where each of its files is exactly as it was
in the fork's basis:
- **home** (the basis bubble, same epoch): no member applied after the basis, or still queued,
  changed those files;
- **any other bubble**: neither that bubble nor the basis bubble (followed through `renamed`; its
  files now are a superset of what they were) ever changed them, so both hold the base repo's
  version.

A fork of a ferge bubble only ever goes home. If nothing fits, the fork's own repo becomes a new
bubble's rep, with files = its changes ∪ its basis bubble's files. `place()` does no await between
choosing and queueing (a `pending` member, its series in `diff`), so concurrent placements can't
collide. A fork that changed nothing joins no bubble. A fork from before bases were recorded starts
its own bubble that counts every bubble's files.

**Patch queues** (`RepoDO.applyQueues`, `Box.apply`, `APPLY_SH`). Each bubble has its own Box,
`bubble-<id>`, holding a clone of its rep. That Box is the rep's **only writer**: it applies the
bubble's queue, and runs its neighbour merges and ferges. Because nothing else writes the rep, the
clone is never fetched. It is cloned fresh when the container is new or after a failed job, which
also avoids incremental fetches from Artifacts (they intermittently fail to negotiate). Every alarm,
each visible bubble with queued series has its Box `git am --3way` them in queue order, one series
at a time, with the fork's name as committer (`agent@`/`notagent@` + `DOMAIN`) and the authors from
the patches. Then it pushes once. Applied members become `merged` with the next `seq`. A series that
doesn't apply is left out whole and marked `failed`; placement should make that impossible, so it's
logged rather than retried. Rep jobs in one Box run one at a time.

**Tasks** (`backend/src/tasks.ts` rules, `RepoDO.schedule`). Every agent and notagent belongs to a
task. `POST /agents` and `POST /notagents` add a one-task batch and start it; `POST /repos/:r/tasks
{title, description, kind, deps?, bubble?}` files one the way an issue tracker does (a human task
waits to be taken); a superagent adds a whole plan. Every task has a short title: given, or
`shortTitle` of the description (first line, ≤ 60 chars at a word). A dep names a task in the same
batch by key, or an existing task by id. Agents get `# title` then the description as their prompt.
With the setting `taskApproval`, every new task (filed, planned, from `/agents` or `/notagents`, or a ferge
agent's) starts as `awaiting-approval`: it never starts, it can be edited (`PATCH /repos/:r/tasks/:id
{title?, description?}`), and `POST …/approve` opens it.
In yorkle, tasks are the repository's **Tasks** tab (`/repos/:r/tasks`, `/repos/:r/tasks/:id`),
an issue tracker beside the Map tab.
`schedule()` runs from `addTasks`, `retryTask` and every alarm. It starts each `ready` agent task:
it records the fork's basis, forks the task's bubble, records the fork's head as `base_head` and
starts the agent. It marks the
task `in-progress` before any await, so concurrent calls don't double-start it. A failed start
goes back to `open` and retries on a 30 s alarm. An open notagent task waits for a human:
`POST /repos/:r/tasks/:id/take` runs the notagent setup below. If the push token expires unused,
the task is `open` again. When a task's fork is placed, the task is `completed` and its
`explanation` is the commit messages in its patch series, newest first (`explanation`). An agent run that fails marks its task `failed`, and
`POST …/retry` reopens it.

A task with dependencies is `ready` when every dependency is completed **and one visible bubble
holds all their forks fully merged**. Each fork is `merged` or that bubble's rep, the bubble has
no `pending` members (no queued series), and nothing is `owed` to it. The task forks that
bubble. A ferge leaves bubble a without the conflicting files, so it records `owed(L, a)`. In
`absorb`, `renameOwed` follows renames and drops the debt once L and a end up in one bubble,
whichever absorbed which. So a dependent task waits through the ferge, the fix, the unlock and
L's merge.

**Superagent** (`POST /superagents {repo, bubble?, prompt, model?}`, `SUPER_SH`). Runs Claude Code in its
own Box on a **read-only** clone. Its system prompt asks for a JSON plan
`[{key, title, description, kind, deps}]` in `/workspace/task/tasks.json`. The Box alarm checks it with
`validatePlan` (keys unique, deps known, no cycle, ≤ 30 tasks) and calls `addTasks`. Nothing is
placed.

**Skills.** `POST /repos/:r/skills {files: [{path, data(base64)}]}` takes a skills folder picked in yorkle's
Skills tab (`webkitdirectory`); `parseSkillUpload` needs a `SKILL.md` with `name` and `description` frontmatter
and no odd paths, and a skill with the same name is replaced. `DELETE …/skills/:name` removes it (and drops it
from tasks that named it). A task's `skills` (from `POST /agents`, `POST …/tasks`, or a superagent's plan item)
is a list of names: omitted = all the repository's skills at start, `[]` = none. `startAgent` empties
`~/.claude/skills` in the container and unpacks only the chosen ones there (Claude Code lists them to the
model itself) and names them in the system prompt; nothing is written into the clone.
A superagent only gets the list (to assign skills to its tasks), not the files. Skills
committed inside the repository itself are the repository's content and stay visible to Claude Code.

**Deploys** (repo setting `deploys [{name, command, hosts, auth}]`; `POST /repos/:r/deploys {name, bubble}`
by a person only). Like CI, a deployment is a command in a Box (`deploy-<id>`, the `CI_SH` job via `startCI`) on a
clone of the bubble's rep at its commit now, reaching only Artifacts and its `hosts`. The bubble must be
visible with nothing queued, and one deployment runs once per bubble at a time. `auth` entries name a header
for a host; their values are stored apart (KV `deployAuth`, never returned: the API says `hasValue`) and
`Outbound` adds the header to requests to that host, so the credential never enters the sandbox. The result
(`deployDone`) fills the `deploy` row shown on the Deploy tab; a run with no result after 40 minutes is failed.

**Memory.** Agents and superagents get the repo's memory items through `--append-system-prompt`
(never written into the repo). Items added while an agent runs reach it too: `addMemory` has each
running Box write the full list to `$TASK/memory.md` (`Box.pushMemory`), and Claude Code's
`PostToolBatch` hook (`MEMORY_HOOK_SH`, set with `--settings`), which runs before every model request
after the first, hands a changed list to the model once as additional context. They add items by appending lines to `/workspace/task/memory`,
outside the clone. The Box alarm reads at most 10 lines of ≤ 500 chars after a successful run. So
there's no new egress and no API access from the sandbox. Humans manage memory through
`POST /repos/:r/memory {text}` and `DELETE /repos/:r/memory/:id`.

**Notagent: loose forks.** `POST /notagents` (or taking a human task) forks, mints a 1-hour write
token, and records a **loose** fork: pushed to, or waiting to be, and not placed. The alarm notices a
push by reading each pushable fork's head every 5 s (Artifacts `pushed` events would need a
subscription per repo, which takes up to a minute to go live, so a quick first push would be missed).
With the repo setting
`autoPlaceNotagents` (default on), a push revokes the token and starts placement. With it off, the
fork stays loose and takes more pushes (counted) until `POST /repos/:r/forks/:fork/place`. Placing:
the repository's git Box (`git-<id>`) clones the fork and takes its patch series from where it
started (`PATCH_SH`), and `place()` queues it, all forks in parallel; infra failures are retried. A
placement that fails (merge commits in its history, which `format-patch` can't carry; a ferge fix
that no longer fits; too big) leaves the fork loose with the reason. `POST …/forks/:fork/token` mints
a fresh push token for another try. A fork never pushed to is deleted, and its task reopened, when its
token expires. The API reports `waiting` (no push yet), `placing` and `loose` (pushed, not placed).

**CI and review** (repo settings `ci {enabled, command, hosts}`, `review`, `maxAgentPushes`;
`src/settings.ts` `gate`). With CI on, every new head of a loose fork runs CI: the command runs in its
own Box (`ci-<fork>`, `CI_SH`) on a clone checked out at that head. A newer push restarts it, and a
result for an older head is dropped. That Box's `Outbound` (props `ci`) reaches Artifacts and the
repository's CI hosts only, never Anthropic, and no key is added. No command = the build step passes.
Review is part of CI and starts once the build passes: **automatic** (`src/reviewer.ts`, an Agents SDK
agent per fork; it reviews the task and the fork's patch series with the Claude API, structured output
and the server-side fallback, then calls `RepoDO.reviewDone`), **manual** (`POST …/forks/:fork/review
{approve, comment}`), or both. A fork is placed only once the gate passes (`place()` and
`requestPlacement` both check it): an agent's at once; a notagent's per `autoPlaceNotagents`. When a
step fails, an agent's fork gets a **fixer**: a new agent run on the same fork (`<fork>-c<n>`, prompt from
`fixPrompt`: the task, what failed, the CI log tail, review comments). Each fixer push counts toward
`maxAgentPushes`. At the limit, or if a fixer fails or changes nothing, the fork and its task become a
notagent's, for a person to push the fix (`POST …/token`). A notagent's failed CI waits for its next push.

**Models, keys and transcripts.** A repository can set its own API key (`PUT …/settings {apiKey}`;
stored apart from the settings and never returned: the API only says `hasKey`), its `provider`
(`anthropic` or `openrouter`), and a model per role (`models.agent` / `superagent` / `ferge`; empty =
the Worker's `MODEL`). An agent's Box binds `Outbound` with its repository (props `repo`). Outbound asks
`RepoDO.credentials` and adds that key (there is no fallback: without a key no agent, superagent,
CI fixer or review starts, and queued tasks wait for one): as
`x-api-key` for `api.anthropic.com`, or as a bearer token for `openrouter.ai`, which Claude Code
reaches through `ANTHROPIC_BASE_URL`. A request to the other provider is refused. The Reviewer uses
the same key and the agent model. Claude Code runs with `--output-format stream-json`: each run's events
go to `$TASK/transcript.jsonl` and are stored in the Box's SQLite when it ends (lines over 256 KB become
stubs). `GET /agents/:id/transcript` serves them, live from the container while it runs.

**Agent.** `RepoDO.schedule` forks and calls `Box.startAgent`: clone (recording the commit it
starts from), `claude --print …`, commit, push to its own fork, all detached in the container. The
Box alarm checks every 30 s. When it's done, the same container takes the patch series (`PATCH_SH`)
and calls `RepoDO.submit`: with CI off that places it; with CI on the fork becomes loose and goes
through CI. A failed first run deletes the fork. Then it reports to `RepoDO.agentDone`. A placed
fork's repo is deleted unless it became a new bubble's rep.

**Merge loop** (`RepoDO.alarm`, running **concurrently with placement**). Each tick applies every
bubble's queue (above) and tries one neighbour merge: a visible bubble with an empty queue and its
nearest non-conflicting neighbour with an empty queue (distance 0 first, so bubbles that share no
files simply merge next). Both are hidden; the neighbour's rep is cloned, fetched from that local
copy and merged into this rep by this bubble's Box (`MERGE_SH`), then pushed. On success the
neighbour is absorbed: its members move over, its rep becomes a `merged` member, its conflicts,
ferge debts and basis follow (`renamed`), this bubble's `epoch` goes up, and the neighbour's repo
and Box go. On conflict the pair is recorded. Both are shown again.

Running alongside placement is safe: placement never picks a hidden bubble, a queue only grows by
placement, and the neighbour merge only takes bubbles with empty queues and hides them before its
first await, so a series always reaches the rep of the bubble it was queued in. Infra errors throw;
the alarm retries. Only a merge conflict counts as a conflict. Forks queued before patch series
(`pending` with no `diff`) are merged in by the bubble's Box the old way.

**Hidden bubbles are leased.** Hiding records the time in `hidden(id, since)`. If the operation
dies first (cancelled alarm, reset, deploy), its bubbles would stay hidden, blocking merges and
ferges on them. So every alarm run and every ferge first un-hides bubbles hidden for over 15 min
(the alarm's own wall-clock limit; real merges take seconds). A fresh object instance un-hides all
of them, since nothing from the old instance is still running.
Locked bubbles are never neighbour-merged, on either side, but their own queues are still applied.

**Lock / unlock** (`POST /repos/:repo/lock|unlock`). Unlocking wakes the merge loop.

**Ferge** (`POST /repos/:repo/ferge {a, b}`, `RepoDO.ferge`, `FERGE_SH`). Only for a pair in
`conflict`, both visible, unlocked and with empty queues; both are hidden while it runs. In a's Box,
on a's clone:
1. `git merge-tree` lists the files that conflict between the two reps.
2. A real `git merge` captures those files with conflict markers.
3. The files are removed from both sides, and b's changes land on a's rep as one squashed commit.
4. A new fork of a's rep gets a commit adding the marker files.

Then b is absorbed into a (its rep repo and Box deleted), the conflict row goes, and the new fork
becomes a **locked ferge bubble** (`ferge = 1`). Its file set is everything in its tree (like any new
bubble); the API returns just the conflicting files. A fix forked from it only ever goes back into
it (the home rule lets it change the conflicting files there), and it stays locked until someone
unlocks it, so the fix merges back with it. A fix that no longer fits there fails. With the setting
`fergeAgents`, the ferge also files an agent task on the ferge bubble to resolve its markers, run with
the `models.ferge` model (task `role` = ferge).

A person can resolve the markers in yorkle's Conflicts tab (`Conflicts.svelte`; the files are the ones
the ferge commit wrote that still hold markers). `POST /repos/:repo/ferge/:bubble/resolve {files}`
(`RepoDO.resolveFerge`) files a notagent task on the bubble, takes it, commits the files to its fork
in the repository's git Box (`COMMIT_FILES_SH`, author = the person) and asks for placement as for
any push; unlocking stays manual.

## Sandbox and secrets

- Containers start with `enableInternet: false`; all HTTP(S) goes through `Outbound`. That allows
  `*.artifacts.cloudflare.net` (rules: `settings.ts` `egress`). Agent Boxes reach the internet (http
  too, for apt) and install what they need as root; their repository's model API gets the
  repository's key added there, so no key ever enters a sandbox. CI Boxes reach only Artifacts and
  their CI hosts, other Boxes only Artifacts.
- Git auth is a short-lived, per-repo Artifacts token embedded in the remote URL.
- The API (apart from signup, verify, login) needs a session token or `BLINGO_TOKEN`, because it
  mints push tokens and starts paid runs. Repository routes also check the caller owns the repo.

## Known limits

Marked with `ponytail:` comments in the code.

- Neighbour merges run one at a time per repository, and a bubble whose queue never empties is
  never neighbour-merged.
- One Box per bubble while it has work (30-minute inactivity timeout).
- A patch series is kept in SQLite, so one over 1.5 MB isn't placed. `format-patch` can't carry merge
  commits, so a notagent fork with merges in its history isn't placed.
- Placement is conservative where a fork's basis bubble has since absorbed others: the basis's
  current files stand in for what they were.
- Loose forks are polled every 5 s; several pushes within one window count as one.
- Bubble rules are by file path only; semantic conflicts surface at merge or not at all.
- Agent runs are listed per repository; there is no cross-repository list.
- A dependent task waits indefinitely while its dependencies sit in conflicting bubbles (until a
  ferge and its fix land), or while a dependency's fork is in member `conflict`.
- Tasks can't be edited or deleted after creation. Every memory item goes into every prompt.
- The UI polls `GET /repos/:repo` (every 2.5 s on the map); the repository list fetches one summary per repo.
- A commit's diff is against its first parent; line diffs are computed in the browser from both blobs.
- No rate limit on login or signup; no password reset, invite expiry or repo sharing.
