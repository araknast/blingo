# Shared helpers for the shell e2e scripts; source it. No secrets here: pass them in the environment.
: "${BLINGO_URL:?set BLINGO_URL, e.g. https://blingo.<subdomain>.workers.dev}"
: "${BLINGO_TOKEN:?set BLINGO_TOKEN (the admin API token)}"
U=$BLINGO_URL
T=$BLINGO_TOKEN
E2E=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$E2E")
export GIT_AUTHOR_NAME=e2e GIT_AUTHOR_EMAIL=e2e@x GIT_COMMITTER_NAME=e2e GIT_COMMITTER_EMAIL=e2e@x

api() { curl -s -H "authorization: Bearer $T" "$@"; }
# key <repo>: give a repository the API key its agents run on (blingo has none of its own).
key() { : "${E2E_ANTHROPIC_KEY:?set E2E_ANTHROPIC_KEY: agents run only on the key of their repository}"; api -X PUT --json "{\"apiKey\":\"$E2E_ANTHROPIC_KEY\"}" "$U/repos/$1/settings" >/dev/null; }
# j <file.json> <key>
j() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$@"; }
# tasks_done <repo>: every task in the repository is completed; prints the ones that aren't.
tasks_done() {
	api "$U/repos/$1" | python3 -c "
import json,sys;d=json.load(sys.stdin);loose={l['fork']:l for l in d['loose']}
bad=[t for t in d['tasks'] if t['status']!='completed']
for t in bad: print('  unresolved task',t['id'],t['status'],t['kind'],t.get('fork'),loose.get(t.get('fork'),{}).get('reason') or '')
print('  tasks:',len(d['tasks']),'| unresolved:',len(bad));sys.exit(1 if bad else 0)"
}
# push <notagent json> <work dir> <shell edit>: clone the fork, run the edit, commit, push.
push() {
	local cmd url; cmd=$(j "$1" push); url=${cmd#git push }; url=${url% HEAD:main}
	rm -rf "$2"; git clone -q "$url" "$2" 2>/dev/null &&
		(cd "$2" && eval "$3" && git add -A && git commit -qm "$(basename "$2")" && git push -q "$url" HEAD:main)
}
