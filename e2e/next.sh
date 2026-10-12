# next.sh: the account's defaults reach a new repository (key included) and it records when it was
# created; patch series over 1.5 MB are placed and applied (kept in parts); a bubble's clone URL clones
# it; and with ferge agents on, a locked ferge bubble isn't a "needs you" while its agent works, manual
# resolution is refused meanwhile, and the bubble unlocks itself once the agent's fix lands.
# Needs E2E_OPENROUTER_KEY (the ferge agent runs on it). Restores the account's defaults to the
# initial ones on exit. ~10 min. Exits non-zero on failure.
. "$(dirname "$0")/env.sh"
: "${E2E_OPENROUTER_KEY:?set E2E_OPENROUTER_KEY}"
M=${MODEL:-deepseek/deepseek-v4.1-flash}
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "$R" ] && api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print([(b['name'],b['ferge'],b['locked'],[m['status'] for m in b['members']]) for b in d['bubbles']], d['conflicts'], [(t['role'],t['status']) for t in d['tasks']])"; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
notagent() { api -X POST --json "$1" $U/notagents; }
placed() { echo "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$1'] in (['rep'], ['merged'])"; }
cleanup() {
	api -X PUT --json '{"provider":"claude-subscription","apiKey":"","autoFerge":false,"fergeAgents":false,"models":{"agent":"","superagent":"","ferge":""}}' $U/me/defaults >/dev/null
	[ -n "$R" ] && [ -z "$KEEP" ] && api -X DELETE $U/repos/$R >/dev/null
}
trap cleanup EXIT

# 1. Defaults reach a new repository.
r=$(api -X PUT --json "{\"provider\":\"openrouter\",\"apiKey\":\"$E2E_OPENROUTER_KEY\",\"autoFerge\":true,\"fergeAgents\":true,\"models\":{\"agent\":\"$M\",\"ferge\":\"$M\"}}" $U/me/defaults)
echo "$r" | grep -q '"hasKey":true' || fail "defaults: $r"
echo "$r" | grep -q "$E2E_OPENROUTER_KEY" && fail "defaults returned the key"
notagent '{"description":"base with a big file"}' > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
api $U/repos/$R/settings | python3 -c "
import json,sys;s=json.load(sys.stdin)
assert s['provider']=='openrouter' and s['hasKey'] and s['keyProvider']=='openrouter' and s['fergeAgents'] and s['autoFerge'] and s['models']['ferge']=='$M', s" || fail "settings not copied"
api $U/me | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['created'].get('$R',0)>0" || fail "no creation date"
ok "a new repository starts with the account's defaults and its creation date"

# 2. Series over 1.5 MB: a ~2.7 MB file starts the bubble, then a ~5 MB series replaces it.
push x0.json r0 'head -c 2000000 /dev/urandom | base64 > big.txt; printf "line1\nline2\nline3\n" > a.txt' >/dev/null || fail "base push"
until_ "$(placed $A)" "big base placed" 300
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"replace the big file\"}" > xb.json; FB=$(j xb.json fork)
push xb.json rb 'head -c 2000000 /dev/urandom | base64 > big.txt' >/dev/null || fail "big push"
until_ "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$FB'] == ['merged']" "big series applied" 300
ok "series of $(du -k rb/big.txt | cut -f1) KB files placed and applied"

# 3. Clone the bubble: it has the second big file.
url=$(api $U/repos/$R/$A/clone | python3 -c "import json,sys;print(json.load(sys.stdin)['url'])") || fail "no clone url"
git clone -q "$url" cl 2>/dev/null || fail "clone failed"
cmp -s cl/big.txt rb/big.txt || fail "the clone's big.txt differs from what was pushed"
ok "the bubble's clone URL clones it, with the applied series"

# 4. A ferge with an agent: not a "needs you" while it works; the person waits; it unlocks itself.
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"ALPHA\"}" > x1.json; F1=$(j x1.json fork)
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"BETA\"}" > x2.json; F2=$(j x2.json fork)
push x1.json r1 'sed -i s/line1/ALPHA/ a.txt' >/dev/null || fail "push 1"
until_ "$(placed $F1)" "ALPHA placed"
push x2.json r2 'sed -i s/line1/BETA/ a.txt' >/dev/null || fail "push 2"
until_ "$(placed $F2)" "BETA placed"
until_ "any(b['ferge'] and b['locked'] for b in d['bubbles']) and any(t['role']=='ferge' and t['status'] in ('open','in-progress') for t in d['tasks'])" "autoFerge ferged and started a ferge agent" 300
L=$(q "[b['id'] for b in d['bubbles'] if b['ferge']][0]")
n=$(api $U/repos/$R/summary | python3 -c "import json,sys;print(json.load(sys.stdin)['needs'])")
[ "$n" = 0 ] || fail "needs is $n while the ferge agent works"
r=$(api -X POST --json '{"files":{"a.txt":"mine\n"}}' $U/repos/$R/ferge/$L/resolve)
echo "$r" | grep -q "agent is resolving" || fail "manual resolution wasn't refused: $r"
ok "while the ferge agent works: nothing needs you, and manual resolution is refused"
until_ "not any(b['id']=='$L' and b['locked'] for b in d['bubbles']) or any(t['role']=='ferge' and t['status']=='failed' for t in d['tasks'])" "the ferge agent finished" 900
[ "$(q "any(t['role']=='ferge' and t['status']=='failed' for t in d['tasks'])")" = True ] && fail "the ferge agent failed"
ok "the ferge bubble unlocked itself once the agent's fix landed"
[ -n "$KEEP" ] && echo "kept repo $R (KEEP set)"
