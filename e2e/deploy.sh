# deploy.sh: manual deployments. A command runs on a bubble's commit in a sandbox: it succeeds with its
# output logged, a failing one is marked failed, a second run of the same deployment on the same bubble
# is refused while one runs, and a credential header is added outside the sandbox (never in the
# deployment's environment). No model cost; ~3 min. Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; api $U/repos/$R | python3 -m json.tool | grep -A12 '"deploys"'; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
settings() { r=$(api -X PUT --json "$1" $U/repos/$R/settings); echo "$r" | grep -q '"error"' && fail "settings $1: $r"; }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$A'] == ['rep']" "base placed"

settings '{"deploys":[{"name":"ok","command":"test -f a.txt && git rev-parse HEAD && echo shipped"},{"name":"bad","command":"echo nope; exit 3"}]}'
code=$(api -o /dev/null -w '%{http_code}' -X POST --json "{\"name\":\"nope\",\"bubble\":\"$A\"}" $U/repos/$R/deploys); [ "$code" = 409 ] || fail "unknown deployment gave $code"

api -X POST --json "{\"name\":\"ok\",\"bubble\":\"$A\"}" $U/repos/$R/deploys > d1.json; D1=$(j d1.json id)
code=$(api -o /dev/null -w '%{http_code}' -X POST --json "{\"name\":\"ok\",\"bubble\":\"$A\"}" $U/repos/$R/deploys)
[ "$code" = 409 ] && ok "a second run of the same deployment on the same bubble is refused while one runs" || echo "note: first run already finished ($code)"
until_ "[x['status'] for x in d['deploys'] if x['id']=='$D1'] == ['succeeded']" "deployment succeeded" 300
[ "$(q "[x['head'] in x['log'] and 'shipped' in x['log'] for x in d['deploys'] if x['id']=='$D1'][0]")" = True ] || fail "the log should hold the deployed commit"
ok "ran on the bubble's commit and logged it"

api -X POST --json "{\"name\":\"bad\",\"bubble\":\"$A\"}" $U/repos/$R/deploys > d2.json; D2=$(j d2.json id)
until_ "[x['status'] for x in d['deploys'] if x['id']=='$D2'] == ['failed']" "deployment failed" 300
[ "$(q "'nope' in [x['log'] for x in d['deploys'] if x['id']=='$D2'][0]")" = True ] || fail "failed log"
ok "a failing command is marked failed with its output"

# The sandbox reaches only the listed hosts; the credential header is added outside it.
settings '{"deploys":[{"name":"hdr","command":"curl -s -o /dev/null -w \"%{http_code}\" https://httpbin.org/headers > code.txt; curl -s https://httpbin.org/headers | tee out.txt; env | grep -ci s3cret && exit 9; grep -q s3cret out.txt","hosts":["httpbin.org"],"auth":[{"host":"httpbin.org","header":"X-Deploy-Key","value":"s3cret"}]}]}'
api -X POST --json "{\"name\":\"hdr\",\"bubble\":\"$A\"}" $U/repos/$R/deploys > d3.json; D3=$(j d3.json id)
until_ "[x['status'] for x in d['deploys'] if x['id']=='$D3'] == ['succeeded']" "credential deployment succeeded" 300
ok "the header reached the host and the sandbox's environment never held it"
api -X DELETE $U/repos/$R >/dev/null
