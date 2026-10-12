# environment.sh: what agents install travels with their work. On one bubble, task 1 installs jq, task 2
# (after 1) installs tree, task 3 (after 2) installs nothing and must find both, by path and by apk.
# 3 agent runs on OpenRouter (E2E_OPENROUTER_KEY, model $MODEL); ~10 min. Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
: "${E2E_OPENROUTER_KEY:?set E2E_OPENROUTER_KEY (an OpenRouter API key)}"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && [ -z "${KEEP:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
key "$R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$A'] == ['rep']" "base placed"

task() { # title description deps-json -> task id
	api -X POST --json "$(python3 -c 'import json,sys;print(json.dumps({"title":sys.argv[1],"description":sys.argv[2],"kind":"agent","bubble":sys.argv[3],"deps":json.loads(sys.argv[4])}))' "$1" "$2" "$A" "$3")" $U/repos/$R/tasks | python3 -c "import json,sys;print(json.load(sys.stdin)['task'])"
}
T1=$(task "Install jq" "Run: apk add --no-cache jq. Then run: jq --version > t1.txt. Commit t1.txt. Do nothing else." '[]')
T2=$(task "Install tree" "Run: apk add --no-cache tree. Then run: tree --version > t2.txt. Commit t2.txt. Do nothing else." "[\"$T1\"]")
T3=$(task "Find tools" "Do not install anything. Run exactly: sh -c 'command -v jq; command -v tree; apk info -e jq tree; grep ^P: /lib/apk/db/installed' > t3.txt 2>&1 ; then commit t3.txt. Do nothing else." "[\"$T2\"]")
until_ "all(t['status'] in ('completed', 'failed') for t in d['tasks'])" "all three agents done" 1800
[ "$(q "[t['id'] for t in d['tasks'] if t['status'] != 'completed']")" = "[]" ] || fail "a task failed: $(q "[(a['log'] or '')[-300:] for a in d['agents'] if a['status']!='placed']")"
ok "three agents placed"
got=$(api "$U/repos/$R/$A?path=t3.txt")
echo "$got" | sed 's/^/     t3.txt: /'
echo "$got" | grep -qx '/usr/bin/jq' || fail "task 3 had no jq"
echo "$got" | grep -qx '/usr/bin/tree' || fail "task 3 had no tree"
echo "$got" | grep -qx 'tree' && echo "$got" | grep -qx 'jq' || fail "apk didn't list both packages"
ok "task 3 found both tools, installed by tasks 1 and 2"
api -X DELETE $U/repos/$R >/dev/null
