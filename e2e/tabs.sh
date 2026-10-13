# tabs.sh: the API behind yorkle's tabs. A skill's contents; rejecting a task awaiting approval (refused
# while another depends on it); the key's provider; partial settings saves; cancelling a running
# deployment; the repository summary's "needs you" count. No model cost; ~2 min. Deletes its repository
# at the end (KEEP=1 keeps it, to look at in yorkle). Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && [ -z "${KEEP:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }
code() { api -o /dev/null -w '%{http_code}' "$@"; }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$A'] == ['rep']" "base placed"

# A skill's contents
md=$(printf -- '---\nname: house-style\ndescription: How we write code here.\n---\n# House style\n\nTabs, not spaces.\n' | base64 -w0)
ex=$(printf 'console.log(1)\n' | base64 -w0)
api -X POST --json "{\"files\":[{\"path\":\"house-style/SKILL.md\",\"data\":\"$md\"},{\"path\":\"house-style/ex/a.js\",\"data\":\"$ex\"}]}" $U/repos/$R/skills > sk.json
grep -q house-style sk.json || fail "skill upload: $(cat sk.json)"
api $U/repos/$R/skills/house-style > skg.json
python3 -c "import json;d=json.load(open('skg.json'));assert 'Tabs, not spaces.' in d['skillMd'];assert {f['path']:f['bytes'] for f in d['files']}=={'SKILL.md':96,'ex/a.js':15}, d['files']" || fail "skill contents: $(cat skg.json)"
[ "$(code $U/repos/$R/skills/nope)" = 404 ] || fail "a missing skill should be 404"
ok "GET skills/:name gives SKILL.md and each file's size; a missing one is 404"

# Rejecting a task
api -X PUT --json '{"taskApproval":true}' $U/repos/$R/settings >/dev/null
api -X POST --json '{"title":"Keep me","description":"x","kind":"notagent"}' $U/repos/$R/tasks > t1.json; T1=$(j t1.json task)
api -X POST --json "{\"title\":\"Drop me\",\"description\":\"x\",\"kind\":\"notagent\",\"deps\":[\"$T1\"]}" $U/repos/$R/tasks > t2.json; T2=$(j t2.json task)
[ "$(q "[t['status'] for t in d['tasks'] if t['id'] in ('$T1','$T2')]")" = "['open', 'open']" ] || fail "new tasks start without approval"
[ "$(code -X POST $U/repos/$R/tasks/$T1/reject)" = 409 ] || fail "rejecting a task another depends on should be refused"
[ "$(code -X POST $U/repos/$R/tasks/$T2/reject)" = 200 ] || fail "reject"
[ "$(q "'$T2' in [t['id'] for t in d['tasks']]")" = False ] || fail "a rejected task should be gone"
[ "$(code -X POST $U/repos/$R/tasks/$T1/reject)" = 200 ] || fail "reject once nothing depends on it"
ok "reject deletes an open task, and refuses while another depends on it"

# The key's provider; partial saves
api -X PUT --json '{"provider":"openrouter","apiKey":"sk-fake-not-real"}' $U/repos/$R/settings >/dev/null
[ "$(q "(d['settings']['hasKey'], d['settings']['keyProvider'])")" = "(True, 'openrouter')" ] || fail "keyProvider: $(q "d['settings'].get('keyProvider')")"
api -X PUT --json '{"provider":"claude-subscription"}' $U/repos/$R/settings >/dev/null
[ "$(q "(d['settings']['provider'], d['settings']['keyProvider'])")" = "('claude-subscription', 'openrouter')" ] || fail "switching provider keeps the key's"
ok "a key records its provider, so a switch shows as a mismatch"
api -X PUT --json '{"deploys":[{"name":"slow","command":"echo starting; sleep 600; echo never"}]}' $U/repos/$R/settings >/dev/null
api -X PUT --json '{"autoFerge":true}' $U/repos/$R/settings >/dev/null
[ "$(q "([x['name'] for x in d['settings']['deploys']], d['settings']['autoFerge'], d['settings']['taskApproval'])")" = "(['slow'], True, True)" ] || fail "a partial save should keep the rest"
ok "a partial settings save leaves the others as they were"

# Cancelling a running deployment
api -X POST --json "{\"name\":\"slow\",\"bubble\":\"$A\"}" $U/repos/$R/deploys > d1.json; D1=$(j d1.json id) || fail "deploy: $(cat d1.json)"
sleep 45
[ "$(q "[x['status'] for x in d['deploys'] if x['id']=='$D1']")" = "['running']" ] || fail "it should be running: $(q "[(x['status'],x['log']) for x in d['deploys']]")"
[ "$(code -X POST $U/repos/$R/deploys/$D1/cancel)" = 200 ] || fail "cancel"
until_ "[x['status'] for x in d['deploys'] if x['id']=='$D1'] == ['failed']" "the cancelled deployment failed" 60
[ "$(q "'cancelled by a person' in [x['log'] for x in d['deploys'] if x['id']=='$D1'][0]")" = True ] || fail "cancel reason in its log"
[ "$(code -X POST $U/repos/$R/deploys/$D1/cancel)" = 409 ] || fail "cancelling a finished one should be refused"
ok "cancel stops a running deployment and keeps its output"

# The summary's count: the key mismatch and the cancelled deployment; a missing key isn't counted.
N=$(api $U/repos/$R/summary | python3 -c 'import json,sys;print(json.load(sys.stdin)["needs"])')
[ "$N" = 2 ] || fail "summary needs = $N: $(api $U/repos/$R/summary)"
api -X PUT --json '{"apiKey":""}' $U/repos/$R/settings >/dev/null
N=$(api $U/repos/$R/summary | python3 -c 'import json,sys;print(json.load(sys.stdin)["needs"])')
[ "$N" = 1 ] || fail "with no key, summary needs = $N (a missing key isn't a need)"
ok "the repository summary counts what needs you, and not a missing key"

[ -n "${KEEP:-}" ] && echo "kept $R" || api -X DELETE $U/repos/$R >/dev/null
