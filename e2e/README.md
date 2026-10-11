# End-to-end tests

Scripts that drive a running blingo. None of them hold secrets: pass `BLINGO_URL` and `BLINGO_TOKEN`
(the admin API token) in the environment. Each creates its own repositories; all but the stress
test delete them when they finish.

| Script | Against | What it checks | Cost |
|---|---|---|---|
| `smoke-local.mjs` | `wrangler dev --enable-containers=false` (defaults: `localhost:8799`, token from `backend/.dev.vars`) | memory, notagent tasks and titles, `POST /repos/:r/tasks`, dependencies, list order, push detection | seconds |
| `ui-screens.mjs [dir]` | `npm run dev -- --enable-containers=false` (yorkle on `:8787`), or a deployed yorkle with `YORKLE_URL` and `BLINGO_TOKEN` | screenshots of the splash and a repository's Map, Tasks, Agents, Memory and Settings tabs, a task page and dialogs (into `e2e/screens/`, gitignored) | seconds; set `CHROMIUM` if Playwright's browser doesn't match |
| `tabs.sh` | deployed (`BLINGO_URL`, `BLINGO_TOKEN`) | the API behind the tabs: skill contents, rejecting a task awaiting approval, the key's provider, partial settings saves, cancelling a deployment, the summary's needs count (`KEEP=1` keeps the repository) | ~2 min |
| `ui-map.mjs [dir]` | deployed (`YORKLE_URL`, `BLINGO_TOKEN`) | screenshots of a lived-in map (named bubbles, a ferge bubble, a running agent, a loose fork that failed CI), the loose fork's page and an agent's run page | ~3 min |
| `tasks.mjs [repo2]` | deployed | agents + memory end to end; superagent plan, dependency scheduling, conflict → ferge → fix → unlock, and that dependent tasks wait throughout (`repo2` = only that part) | ~5 Claude runs, ~5 min |
| `loose.sh` | deployed | loose notagent forks: auto-placement off, several pushes, placement on request, a merge-commit history refused then pushed again | ~2 min |
| `ci.sh` | deployed | CI and review: a notagent's CI fails then passes, placing early is refused, manual review gates placement, a fixer agent fixes an agent's failed CI, the push limit hands the fork to a person, automatic review approves one change and rejects another | ~3 Claude runs, 2 reviews, ~15 min |
| `skills.sh` | deployed | skills upload; an agent started with `skills: ["alpha"]` has only that skill in its container and one with `[]` has none | 2 agent runs (OpenRouter, `E2E_OPENROUTER_KEY`), ~5 min |
| `deploy.sh` | deployed | deployments: success logs the deployed commit, a failing command is marked failed, a duplicate run is refused, a credential header is added outside the sandbox | ~3 min |
| `autoferge.sh` | deployed | the setting `autoFerge`: two conflicting bubbles stay put while it's off, then the merge loop ferges them by itself (a locked ferge bubble with the markers; the rest reaches A) | ~3 min, no model cost |
| `models.sh` | deployed | a repository's own API key (never returned), models, the OpenRouter and Claude subscription providers, and agent transcripts, using invalid keys so runs fail at their first API call | ~4 min, no model cost |
| `names.sh` | deployed | repository and bubble names, the ferge bubble's name and flag, a ferge agent's task, task approval and editing | ~4 min |
| `ferge-fix.sh` | deployed | conflict → ferge → fix forked from the ferge bubble → unlock; prints bubbles after each step | ~3 min |
| `stress/run.sh` | deployed | 40-file repo, 60 notagents pushed 20 at a time, ferge and fix each conflict, everything ends in one bubble and every task completed (sizes are env vars: `FILES`, `N_NEW`, `N_EDIT`, `N_PAIRS`, `N_CONF`, `P`, `BATCH`) | ~30 min; leaves the repo |
| `stress/super.sh` | deployed | `run.sh` at scale: 2001 notagents in batches of 200, ≥ 100 clean bubble merges, 1 ferge | hours; leaves the repo |
| `stress/rerun.sh` | deployed | `run.sh` with `wrangler tail` of both Workers saved to the work dir | as above |

```sh
export BLINGO_URL=https://blingo.<subdomain>.workers.dev BLINGO_TOKEN=…
node e2e/tasks.mjs
bash e2e/ferge-fix.sh
WORK=/tmp/stress bash e2e/stress/rerun.sh      # optional: CF_ACCOUNT_ID, CONTAINER_APP_ID for container usage
```

The shell scripts share `env.sh` (`api`, `j`, `push`); set `WORK` to keep their files somewhere known.
