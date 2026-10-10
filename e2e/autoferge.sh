# autoferge.sh: with the setting autoFerge, two forks that conflict on a.txt are ferged by the merge
# loop itself (no POST /ferge): the conflict goes, a locked ferge bubble holds a.txt with markers, and
# the other bubble's non-conflicting file reaches A. No model cost; ~3 min. Exits non-zero on failure.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print([(b['name'],b['ferge'],b['locked'],[m['status'] for m in b['members']]) for b in d['bubbles']], d['conflicts'])"; api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
file() { api "$U/repos/$R/$1?path=$2"; }
notagent() { api -X POST --json "$1" $U/notagents; }
placed() { echo "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$1'] in (['rep'], ['merged'])"; }

notagent '{"description":"base a.txt"}' > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'printf "line1\nline2\nline3\n" > a.txt' >/dev/null || fail "base push"
until_ "$(placed $A)" "base placed"

notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"ALPHA\"}" > x1.json; F1=$(j x1.json fork)
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"BETA\"}" > x2.json; F2=$(j x2.json fork)
push x1.json r1 'sed -i s/line1/ALPHA/ a.txt' >/dev/null || fail "push 1"
until_ "$(placed $F1)" "ALPHA placed"
push x2.json r2 'sed -i s/line1/BETA/ a.txt; echo beta > beta.txt' >/dev/null || fail "push 2"
until_ "$(placed $F2)" "BETA placed"
until_ "len(d['conflicts']) == 1" "the two bubbles conflict"
ok "conflict recorded; autoFerge is off, so nothing happens"
sleep 15; [ "$(q "len(d['conflicts'])")" = 1 ] || fail "ferged without the setting"

r=$(api -X PUT --json '{"autoFerge":true}' $U/repos/$R/settings); echo "$r" | grep -q '"autoFerge":true' || fail "setting: $r"
until_ "len(d['conflicts']) == 0 and any(b['ferge'] and b['locked'] for b in d['bubbles'])" "the merge loop ferged them" 240
L=$(q "[b['id'] for b in d['bubbles'] if b['ferge']][0]")
file $L a.txt | grep -q '^<<<<<<<' || fail "ferge bubble a.txt has no markers: $(file $L a.txt)"
[ "$(file $A beta.txt)" = beta ] || fail "beta.txt should have reached A"
ok "ferged automatically: a locked ferge bubble holds the markers, the rest merged"
api -X DELETE $U/repos/$R >/dev/null
