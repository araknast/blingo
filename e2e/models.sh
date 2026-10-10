# models.sh: a repository's own API key, provider and models, and agent transcripts. Uses deliberately
# invalid keys, so each agent run fails at its first API call and costs nothing; the error it gets
# shows whose key and which provider the sandbox's requests went to, and the stored transcript shows
# the model. Exits non-zero on the first failed check. ~4 min.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
KEY=sk-ant-api03-blingo-e2e-not-a-real-key
api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
for i in $(seq 1 36); do api $U/repos/$R | grep -q '"status":"rep"' && break; sleep 5; done

r=$(api -X PUT --json "{\"apiKey\":\"$KEY\",\"models\":{\"agent\":\"claude-haiku-5-5\"}}" $U/repos/$R/settings)
echo "$r" | grep -q '"hasKey":true' || fail "key not stored: $r"
for p in "/repos/$R/settings" "/repos/$R"; do api $U$p | grep -q "$KEY" && fail "the key is visible in GET $p"; done
ok "key stored, never returned"

# run <title> [model]: start an agent, wait for its run to finish, save its transcript to <title>.json
run() {
	local f; f=$(api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"title\":\"$1\",\"prompt\":\"Create $1.txt.\",\"model\":\"${2:-}\"}" $U/agents | python3 -c "import json,sys;print(json.load(sys.stdin)['fork'])")
	[ -n "$f" ] && [ "$f" != None ] || fail "agent $1 didn't start"
	for i in $(seq 1 60); do
		api $U/agents/$f/transcript > $1.json
		python3 -c "import json,sys;sys.exit(json.load(open('$1.json'))['status'] in ('running','none'))" && return 0
		sleep 5
	done
	fail "agent $1 didn't finish"
}
# ev <file> <python expr over events e>
ev() { python3 -c "import json;e=json.load(open('$1'))['events'];print($2)"; }

run haiku
[ "$(ev haiku.json "[x.get('model') for x in e if x.get('type')=='system' and x.get('subtype')=='init']")" = "['claude-haiku-5-5']" ] || fail "model in transcript: $(ev haiku.json "e[:1]")"
[ "$(ev haiku.json "[x.get('api_error_status') for x in e if x.get('type')=='result']")" = "[401]" ] || fail "expected Anthropic to reject the repo's (invalid) key: $(ev haiku.json "[x.get('result') for x in e if x.get('type')=='result']")"
ok "transcript stored; the repo's model and key were used ($(ev haiku.json "[x.get('result') for x in e if x.get('type')=='result'][0][:80]"))"

run sonnet claude-sonnet-5-5
[ "$(ev sonnet.json "[x.get('model') for x in e if x.get('type')=='system' and x.get('subtype')=='init']")" = "['claude-sonnet-5-5']" ] || fail "the agent's own model wasn't used: $(ev sonnet.json "e[:1]")"
ok "a model chosen for one agent beats the repo's"

api -X PUT --json '{"apiKey":"","models":{"agent":""}}' $U/repos/$R/settings | grep -q '"hasKey":false' || fail "key not removed"
code=$(api -o /dev/null -w '%{http_code}' -X POST --json "{\"repo\":\"$R\",\"prompt\":\"x\"}" $U/agents)
[ "$code" = 400 ] || fail "an agent started without a repo key ($code)"
ok "without a repo key, no agent starts (blingo has no key of its own)"

api -X PUT --json "{\"apiKey\":\"sk-or-v1-blingo-e2e-not-a-real-key\",\"provider\":\"openrouter\",\"models\":{\"agent\":\"anthropic/claude-haiku-4.5\"}}" $U/repos/$R/settings >/dev/null
run router
res=$(ev router.json "[(x.get('api_error_status'), x.get('result')) for x in e if x.get('type')=='result']")
[ "$(ev router.json "[x.get('model') for x in e if x.get('subtype')=='init']")" = "['anthropic/claude-haiku-4.5']" ] || fail "router model"
# 401 = OpenRouter rejected the fake key; Outbound blocking a request to the wrong host would be a 403.
[ "$(ev router.json "[x.get('api_error_status') for x in e if x.get('type')=='result']")" = "[401]" ] || fail "expected OpenRouter to reject the fake key: $res"
ok "OpenRouter provider: requests went to OpenRouter with the repo's key ($res)"

echo "== cleanup: $(api -X DELETE $U/repos/$R)"
echo "PASS"
