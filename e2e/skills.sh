# skills.sh: only the skills named for an agent are installed in its container. Uploads two skills, starts
# one agent with skills ["alpha"] and one with [] and asks each to list ~/.claude/skills into a file.
# 2 agent runs on OpenRouter (E2E_OPENROUTER_KEY, model $MODEL); ~5 min. Exits non-zero on the first failed check.
. "$(dirname "$0")/env.sh"
: "${E2E_OPENROUTER_KEY:?set E2E_OPENROUTER_KEY (an OpenRouter API key)}"
MODEL=${MODEL:-deepseek/deepseek-v4.1-flash}
S=${WORK:-$(mktemp -d)}; mkdir -p "$S" && cd "$S" || exit 1; echo "work dir $S"
fail() { echo "FAIL $*"; [ -n "${R:-}" ] && api -X DELETE $U/repos/$R >/dev/null; exit 1; }
ok() { echo "ok   $*"; }
q() { api $U/repos/$R | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
until_() { for i in $(seq 1 $(( ${3:-180} / 5 ))); do [ "$(q "$1")" = True ] && return 0; sleep 5; done; fail "timed out waiting for: $2"; }

api -X POST --json '{"description":"base"}' $U/notagents > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R"
api -X PUT --json "{\"provider\":\"openrouter\",\"apiKey\":\"$E2E_OPENROUTER_KEY\",\"models\":{\"agent\":\"$MODEL\"}}" $U/repos/$R/settings | grep -q '"error"' && fail "settings"
push x0.json r0 'echo a > a.txt' >/dev/null || fail "base push"
until_ "[m['status'] for b in d['bubbles'] for m in b['members'] if m['name']=='$A'] == ['rep']" "base placed"

skill() { # name -> JSON body for POST /skills
	python3 - "$1" <<'E'
import base64, json, sys
n = sys.argv[1]
md = f"---\nname: {n}\ndescription: The {n} skill\n---\nSay {n}."
print(json.dumps({"files": [{"path": f"{n}/SKILL.md", "data": base64.b64encode(md.encode()).decode()}]}))
E
}
for n in alpha beta; do [ "$(api -o /dev/null -w '%{http_code}' -X POST --json "$(skill $n)" $U/repos/$R/skills)" = 201 ] || fail "upload $n"; done
[ "$(q "[s['name'] for s in d['skills']]")" = "['alpha', 'beta']" ] || fail "skills listed"
ok "two skills uploaded"

ask() { # title skills-json -> fork
	api -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"title\":\"$1\",\"skills\":$2,\"prompt\":\"Run: ls ~/.claude/skills > skills-$1.txt (write an empty file if the folder is missing). Do nothing else.\"}" $U/agents | python3 -c "import json,sys;print(json.load(sys.stdin)['fork'])"
}
F1=$(ask one '["alpha"]'); F2=$(ask none '[]')
until_ "all(t['status'] in ('completed', 'failed') for t in d['tasks'])" "both agents done" 900
[ "$(q "[(a['log'] or '')[-200:] for a in d['agents'] if a['status']!='placed']")" = "[]" ] || fail "an agent failed: $(q "[(a['log'] or '')[-200:] for a in d['agents'] if a['status']!='placed']")"
src() { api "$U/repos/$R/$A?path=$1"; }
[ "$(src skills-one.txt | tr -d '[:space:]')" = "alpha" ] || fail "agent one should have only alpha: $(src skills-one.txt)"
[ -z "$(src skills-none.txt | tr -d '[:space:]')" ] || fail "agent none should have no skills: $(src skills-none.txt)"
ok "agents had exactly the skills named for them"
api -X DELETE $U/repos/$R >/dev/null
