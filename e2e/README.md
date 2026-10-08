# End-to-end tests

Scripts that drive a running blingo. None of them hold secrets: pass `BLINGO_URL` and `BLINGO_TOKEN`
(the admin API token) in the environment. Each creates its own repositories; all but the stress
test delete them when they finish.

| Script | Against | What it checks | Cost |
|---|---|---|---|
| `smoke-local.mjs` | `wrangler dev --enable-containers=false` (defaults: `localhost:8799`, token from `backend/.dev.vars`) | memory, notagent tasks and titles, `POST /repos/:r/tasks`, dependencies, list order, push detection | seconds |
| `ui-screens.mjs [dir]` | `npm run dev -- --enable-containers=false` (yorkle on `:8787`) | screenshots of the Map and Tasks tabs, a task page and dialogs (into `e2e/screens/`, gitignored) | seconds; set `CHROMIUM` if Playwright's browser doesn't match |
| `tasks.mjs [repo2]` | deployed | agents + memory end to end; superagent plan, dependency scheduling, conflict → ferge → fix → unlock, and that dependent tasks wait throughout (`repo2` = only that part) | ~5 Claude runs, ~5 min |
| `ferge-fix.sh` | deployed | conflict → ferge → fix forked from the ferge bubble → unlock; prints bubbles after each step | ~3 min |
| `stress/run.sh` | deployed | 40-file repo, 60 notagents pushed 20 at a time, ferge and fix each conflict, everything ends in one bubble | ~30 min; leaves the repo |
| `stress/rerun.sh` | deployed | `run.sh` with `wrangler tail` of both Workers saved to the work dir | as above |

```sh
export BLINGO_URL=https://blingo.<subdomain>.workers.dev BLINGO_TOKEN=…
node e2e/tasks.mjs
bash e2e/ferge-fix.sh
WORK=/tmp/stress bash e2e/stress/rerun.sh      # optional: CF_ACCOUNT_ID, CONTAINER_APP_ID for container usage
```

The shell scripts share `env.sh` (`api`, `j`, `push`); set `WORK` to keep their files somewhere known.
