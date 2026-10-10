# names.sh: repository and bubble names, ferge bubbles, ferge agents, task approval. The repository's
# first bubble is called after it, later ones "adjective noun", a ferge bubble after the two it came
# from; with fergeAgents on, a ferge files an agent task (model role "ferge") on its ferge bubble; with
# taskApproval on, tasks wait for approval and can be edited until then. No model cost (the ferge
# agent's run may fail without credit; only its task is checked). ~4 min.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 36); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
bname() { echo "[b['name'] for b in d['bubbles'] if b['id']=='$1'][0]"; }
notagent() { api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"$2\"}" $U/notagents > $1.json; j $1.json fork; }

R=$(api -X POST --json '{"name":"  e2e   names "}' $U/repos | python3 -c "import json,sys;print(json.load(sys.stdin)['repo'])"); echo "repo $R"; key $R
[ "$(api $U/me | python3 -c "import json,sys;print(json.load(sys.stdin)['names'].get('$R'))")" = "e2e names" ] || fail "name in /me"
[ "$(q "d['name']")" = "e2e names" ] || fail "name in the repo state"
ok "repository named (trimmed): e2e names"
api -X POST --json "{\"repo\":\"$R\",\"description\":\"base\"}" $U/notagents > x0.json; A=$(j x0.json fork)
push x0.json r0 'printf "line1\nline2\n" > a.txt' >/dev/null || fail "base push"
until_ "len(d['bubbles']) == 1" "first bubble"
[ "$(q "$(bname $A)")" = "e2e names" ] || fail "first bubble name: $(q "$(bname $A)")"
ok "first bubble is called after the repository"

F1=$(notagent x1 ALPHA); F2=$(notagent x2 BETA)
push x1.json r1 'sed -i s/line1/ALPHA/ a.txt' >/dev/null && push x2.json r2 'sed -i s/line1/BETA/ a.txt' >/dev/null || fail "conflicting pushes"
until_ "len(d['conflicts']) == 1" "conflicting bubbles"
B=$(q "[x for x in d['conflicts'][0] if x != '$A'][0]")
BN=$(q "$(bname $B)"); echo "$BN" | grep -qE '^[a-z]+ [a-z]+$' || fail "second bubble name: $BN"
ok "later bubble got a friendly name: $BN"

api -X PUT --json '{"fergeAgents":true,"taskApproval":true,"models":{"ferge":"claude-haiku-5-5"}}' $U/repos/$R/settings > /dev/null
api -X POST --json "{\"a\":\"$A\",\"b\":\"$B\"}" $U/repos/$R/ferge > ferge.json; L=$(j ferge.json locked) || fail "ferge: $(cat ferge.json)"
got=$(q "$(bname $L)"); [ "$got" = "$(echo "$BN" | cut -d' ' -f1) e2e names$(echo "$BN" | cut -d' ' -f2) ferge" ] || fail "ferge name: $got"
[ "$(q "[b['ferge'] for b in d['bubbles'] if b['id']=='$L']")" = "[True]" ] || fail "ferge flag"
ok "ferge bubble named after both: $got"
[ "$(q "[(t['kind'], t['role'], t['bubble'], t['status']) for t in d['tasks'] if t['title'].startswith('Resolve the conflicts')]")" = "[('agent', 'ferge', '$L', 'awaiting-approval')]" ] || fail "ferge agent task: $(q "d['tasks']")"
ok "ferge agent task filed on the ferge bubble (awaiting approval)"

T1=$(api -X POST --json '{"title":"draft","description":"first draft","kind":"notagent"}' $U/repos/$R/tasks | python3 -c "import json,sys;print(json.load(sys.stdin)['task'])")
[ "$(q "[(t['status'], t['ready']) for t in d['tasks'] if t['id']=='$T1']")" = "[('awaiting-approval', False)]" ] || fail "new task should await approval"
code=$(api -o /dev/null -w '%{http_code}' -X POST $U/repos/$R/tasks/$T1/take); [ "$code" = 409 ] || fail "taking an unapproved task gave $code"
api -X PATCH --json '{"title":"final title","description":"edited"}' $U/repos/$R/tasks/$T1 >/dev/null
[ "$(q "[(t['title'], t['description']) for t in d['tasks'] if t['id']=='$T1']")" = "[('final title', 'edited')]" ] || fail "edit"
api -X POST $U/repos/$R/tasks/$T1/approve >/dev/null
[ "$(q "[t['status'] for t in d['tasks'] if t['id']=='$T1']")" = "['open']" ] || fail "approve"
code=$(api -o /dev/null -w '%{http_code}' -X PATCH --json '{"title":"late"}' $U/repos/$R/tasks/$T1); [ "$code" = 409 ] || fail "editing an approved task gave $code"
r=$(api -X POST --json "{\"repo\":\"$R\",\"description\":\"needs approval\"}" $U/notagents); echo "$r" | grep -q '"awaitingApproval":true' || fail "notagent with approval on: $r"
ok "tasks await approval, can be edited until approved, then open"

echo "== cleanup: $(api -X DELETE $U/repos/$R)"
echo "PASS"
