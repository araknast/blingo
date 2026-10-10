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
key() { : "${E2E_ANTHROPIC_KEY:?set E2E_ANTHROPIC_KEY: agents run only on their repository's key}"; api -X PUT --json "{\"apiKey\":\"$E2E_ANTHROPIC_KEY\"}" "$U/repos/$1/settings" >/dev/null; }
# j <file.json> <key>
j() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$@"; }
# push <notagent json> <work dir> <shell edit>: clone the fork, run the edit, commit, push.
push() {
	local cmd url; cmd=$(j "$1" push); url=${cmd#git push }; url=${url% HEAD:main}
	rm -rf "$2"; git clone -q "$url" "$2" 2>/dev/null &&
		(cd "$2" && eval "$3" && git add -A && git commit -qm "$(basename "$2")" && git push -q "$url" HEAD:main)
}
