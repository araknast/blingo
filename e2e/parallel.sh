# parallel.sh: neighbour merges run in parallel. Five forks of one bubble each edit a different line of
# a.txt; the first lands at home and the other four start bubbles of their own (their file changed at home
# after they forked). Placed together, the merge loop merges disjoint pairs at once: two `merging` rows at
# the same time, and everything ends in one bubble holding every edit. No model cost; ~3 min.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print([(b['name'],[m['status'] for m in b['members']]) for b in d['bubbles']], d['conflicts'], d['merging'])"; api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
notagent() { api -X POST --json "$1" $U/notagents; }
placed() { echo "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$1'] in (['rep'], ['merged'])"; }

notagent '{"description":"base a.txt"}' > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'seq 1 40 | sed s/^/line/ > a.txt' >/dev/null || fail "base push"
until_ "$(placed $A)" "base placed"

# Hold every fork until all are pushed, so their bubbles appear together.
r=$(api -X PUT --json '{"autoPlaceNotagents":false}' $U/repos/$R/settings); echo "$r" | grep -q '"autoPlaceNotagents":false' || fail "setting: $r"
FORKS=""
for k in 1 2 3 4 5; do
	notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"edit line $((k * 8))\"}" > x$k.json
	push x$k.json r$k "sed -i s/^line$((k * 8))\$/EDIT$k/ a.txt" >/dev/null || fail "push $k"
	FORKS="$FORKS $(j x$k.json fork)"
done
until_ "len(d['loose']) == 5" "five forks pushed and waiting"
for f in $FORKS; do api -X POST $U/repos/$R/forks/$f/place >/dev/null & done; wait

# Watch the map: the most merges seen running at once.
most=0
for i in $(seq 1 600); do
	n=$(q "len(d['merging'])"); [ "$n" -gt "$most" ] && most=$n
	[ "$(q "len(d['bubbles']) == 1 and not d['loose'] and not d['placing'] and not d['merging'] and len(d['bubbles'][0]['members']) == 6")" = True ] && break
	sleep 0.3
done
[ "$most" -ge 2 ] || fail "never saw two merges at once (most: $most)"
ok "$most neighbour merges ran at once"
until_ "len(d['bubbles']) == 1 and not d['conflicts']" "everything in one bubble"
B=$(q "d['bubbles'][0]['id']")
got=$(api "$U/repos/$R/$B?path=a.txt")
for k in 1 2 3 4 5; do echo "$got" | grep -qx "EDIT$k" || fail "a.txt lacks EDIT$k: $got"; done
ok "one bubble holding all five edits: $(q "d['bubbles'][0]['name']")"
api -X DELETE $U/repos/$R >/dev/null
