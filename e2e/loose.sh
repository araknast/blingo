# loose.sh: loose notagent forks. With auto-placement off, a fork takes several pushes and is only
# placed on request; a fork whose history has a merge commit stays loose with a reason until it is
# pushed again (with a fresh token) as a straight line. Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
state() { api $U/repos/$R; }
# q <python expr over d (the repo state)>
q() { state | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
# until_ <python condition over d> <what>: poll up to 3 min
until_() { for i in $(seq 1 36); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
member() { echo "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$1']"; }
# again <dir> <url> <edit>: one more commit pushed from an existing clone
again() { (cd "$1" && eval "$3" && git add -A && git commit -qm "$(basename "$1") again" && git push -q "$2" HEAD:main); }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "$(member $A) == ['rep']" "base placed (auto-placement is on by default)"; ok "auto-placed base"

[ "$(api -X PUT --json '{"autoPlaceNotagents":false}' $U/repos/$R/settings)" = '{"autoPlaceNotagents":false}' ] || fail "settings"
ok "auto-placement off"

api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"two pushes\"}" $U/notagents > x1.json; F1=$(j x1.json fork)
URL1=$(j x1.json push); URL1=${URL1#git push }; URL1=${URL1% HEAD:main}
push x1.json r1 'echo one > one.txt' >/dev/null || fail "push 1"
until_ "[l['pushes'] for l in d['loose'] if l['fork']=='$F1'] == [1]" "first push seen"
again r1 "$URL1" 'echo two > two.txt' || fail "push 2"
until_ "[l['pushes'] for l in d['loose'] if l['fork']=='$F1'] == [2]" "second push seen"
[ "$(q "$(member $F1)")" = "[]" ] || fail "loose fork was placed without a request"
ok "two pushes, still loose"
api -X POST $U/repos/$R/forks/$F1/place >/dev/null
until_ "$(member $F1) == ['merged']" "requested placement applied"
[ "$(api "$U/repos/$R/$A?path=two.txt")" = two ] && [ "$(api "$U/repos/$R/$A?path=one.txt")" = one ] || fail "both pushes in the rep"
ok "placed on request, both pushes landed"

api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"merge commit\"}" $U/notagents > x2.json; F2=$(j x2.json fork)
push x2.json r2 'git checkout -qb side && echo s > s.txt && git add s.txt && git commit -qm side && git checkout -q main && git merge -q --no-ff --no-edit side && echo t > t.txt' >/dev/null || fail "push 3"
until_ "[l['pushes'] for l in d['loose'] if l['fork']=='$F2'] == [1]" "merge push seen"
api -X POST $U/repos/$R/forks/$F2/place >/dev/null
until_ "[l['reason'] for l in d['loose'] if l['fork']=='$F2'] != [None] and len([l for l in d['loose'] if l['fork']=='$F2']) == 1" "placement refused"
ok "merge commit refused: $(q "[l['reason'] for l in d['loose'] if l['fork']=='$F2'][0]")"
api -X POST $U/repos/$R/forks/$F2/token > x2b.json; URL2=$(j x2b.json push); URL2=${URL2#git push }; URL2=${URL2% HEAD:main}
(cd r2 && git reset -q --soft origin/main && git commit -qm "flattened" && git push -qf "$URL2" HEAD:main) || fail "flattened push"
until_ "[l['pushes'] for l in d['loose'] if l['fork']=='$F2'] == [2]" "flattened push seen"
api -X POST $U/repos/$R/forks/$F2/place >/dev/null
until_ "$(member $F2) == ['merged']" "flattened fork placed"
ok "fresh token, flattened push, placed"

echo "== cleanup: $(api -X DELETE $U/repos/$R)"
echo "PASS"
