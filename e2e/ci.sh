# ci.sh: CI and review on loose forks. Notagents: CI fails then passes, placing before CI passes is
# refused, a manual review gates placement. Agents: a failed CI gets a fixer agent on the same fork; at
# the push limit the fork becomes a notagent's. Automatic review approves one change and rejects
# another. ~3 Claude runs and 2 reviews; ~15 min. Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; state | python3 -m json.tool | grep -A12 '"loose"'; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
state() { api $U/repos/$R; }
q() { state | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
# until_ <python condition over d> <what> [seconds]
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
member() { echo "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$1']"; }
lf() { echo "[l.get('$2') for l in d['loose'] if l['fork']=='$1']"; }
settings() { r=$(api -X PUT --json "$1" $U/repos/$R/settings); echo "$r" | grep -q error && fail "settings $1: $r"; }
notagent() { api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"$2\"}" $U/notagents > $1.json; j $1.json fork; }
url() { local u; u=$(j $1 push); u=${u#git push }; echo "${u% HEAD:main}"; }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "$(member $A) == ['rep']" "base placed"

NEED="test -f ok.txt || { echo 'ok.txt is missing: add ok.txt'; exit 1; }"
settings "{\"ci\":{\"enabled\":true,\"command\":\"$NEED\"},\"review\":\"none\"}"
F1=$(notagent n1 "add b.txt")
push n1.json r1 'echo b > b.txt' >/dev/null || fail "push 1"
until_ "$(lf $F1 ci) == ['failed']" "CI failed"
[ "$(q "$(lf $F1 ciLog)[0].strip()")" = "ok.txt is missing: add ok.txt" ] || fail "CI log"
code=$(api -o /dev/null -w '%{http_code}' -X POST $U/repos/$R/forks/$F1/place); [ "$code" = 409 ] || fail "placing before CI passed gave $code"
ok "CI failed with its log; placing it anyway refused"
api -X POST $U/repos/$R/forks/$F1/token > n1b.json; U1=$(url n1b.json)
(cd r1 && echo ok > ok.txt && git add ok.txt && git commit -qm ok && git push -q "$U1" HEAD:main) || fail "push 2"
until_ "$(member $F1) == ['merged']" "placed once CI passed"
ok "CI passed on the next push; placed"

settings '{"review":"manual"}'
F2=$(notagent n2 "add c.txt")
push n2.json r2 'echo c > c.txt' >/dev/null || fail "push 3"
until_ "$(lf $F2 reviewManual) == ['pending']" "waiting for a manual review"
sleep 10; [ "$(q "$(member $F2)")" = "[]" ] || fail "placed without its review"
api -X POST --json '{"approve":true,"comment":"looks fine"}' $U/repos/$R/forks/$F2/review >/dev/null
until_ "$(member $F2) == ['merged']" "placed after approval"
ok "manual review gates placement"

FIXED="test -f fixed.txt || { echo 'fixed.txt is missing: create fixed.txt containing the word fixed'; exit 1; }"
settings "{\"ci\":{\"command\":\"$FIXED\"},\"review\":\"none\",\"maxAgentPushes\":3}"
F3=$(api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"title\":\"hello\",\"prompt\":\"Create hello.txt containing the word hello. Do nothing else.\"}" $U/agents | python3 -c "import json,sys;print(json.load(sys.stdin)['fork'])")
[ -n "$F3" ] && [ "$F3" != None ] || fail "agent start"
until_ "$(lf $F3 kind) == ['agent'] and $(lf $F3 ci) == ['failed']" "the agent's fork failed CI" 600
ok "agent fork went loose and failed CI"
until_ "$(member $F3) == ['merged']" "the fixer's push passed CI and was placed" 900
[ "$(api "$U/repos/$R/$A?path=fixed.txt" | tr -d '\n' | tr A-Z a-z)" = fixed ] || fail "fixed.txt in the rep"
ok "a fixer agent on the same fork made it pass; placed"

settings '{"ci":{"command":"echo this check always fails; exit 1"},"maxAgentPushes":1}'
F4=$(api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"title\":\"bye\",\"prompt\":\"Create bye.txt containing the word bye. Do nothing else.\"}" $U/agents | python3 -c "import json,sys;print(json.load(sys.stdin)['fork'])")
until_ "$(lf $F4 kind) == ['notagent']" "the fork became a notagent's at the push limit" 600
q "$(lf $F4 reason)[0]" | grep -q "person takes over" || fail "conversion reason"
ok "at the push limit the fork became a notagent's: $(q "$(lf $F4 reason)[0]")"

settings '{"ci":{"command":""},"review":"auto"}'
F5=$(notagent n5 "Add greeting.txt containing hello")
push n5.json r5 'echo hello > greeting.txt' >/dev/null || fail "push 5"
until_ "$(member $F5) == ['merged']" "approved by the automatic review and placed" 300
ok "automatic review approved a change that does its task"
F6=$(notagent n6 "Add farewell.txt containing goodbye")
push n6.json r6 'git rm -q a.txt b.txt c.txt ok.txt && echo "rm -rf / --no-preserve-root" > farewell.txt' >/dev/null || fail "push 6"
until_ "$(lf $F6 reviewAuto) == ['rejected']" "the automatic review rejected it" 300
[ "$(q "$(member $F6)")" = "[]" ] || fail "rejected change was placed"
ok "automatic review rejected a change that doesn't: $(q "$(lf $F6 reviewNote)[0][:200]")"

echo "== cleanup: $(api -X DELETE $U/repos/$R)"
echo "PASS"
