# Stress test: 40-file repo, then 60 notagents pushed 20 at a time (new files, edits, and 3
# conflicting pairs), ferge + fix + unlock each conflict, then check everything reached one bubble.
# Optional: CF_ACCOUNT_ID and CONTAINER_APP_ID for container usage before/after.
. "$(dirname "$0")/../env.sh"
export D=${D:-${WORK:-$(mktemp -d)}}; echo "work dir $D"
set -u; cd $D; rm -rf na w pushes.log retries.log; mkdir -p na w
T0=$(date +%s); ts() { echo "[$(( $(date +%s) - T0 ))s] $*"; }
summary() { api $U/repos/$(cat repo) | python3 -c "
import json,sys,collections;d=json.load(sys.stdin)
st=collections.Counter(m['status'] for b in d['bubbles'] for m in b['members'])
print('   bubbles',len(d['bubbles']),'| visible',sum(b['visible'] for b in d['bubbles']),'| locked',sum(b['locked'] for b in d['bubbles']),'| forks',dict(st),'| conflicts',len(d['conflicts']),'| waiting',len(d['waiting']),'| placing',len(d['placing']))"; }
# settle: nothing waiting/pending and two reads 15s apart identical; 40 min cap
settle() { local prev= r i; for i in $(seq 1 160); do r=$(api $U/repos/$(cat repo)); if echo "$r" | grep -q '"waiting":\[\]' && echo "$r" | grep -q '"placing":\[\]' && ! echo "$r" | grep -q '"pending"' && [ "$r" = "$prev" ]; then return 0; fi; prev=$r; sleep 15; done; ts "SETTLE TIMEOUT"; summary; return 1; }
usage() { [ -n "${CF_ACCOUNT_ID:-}" ] && [ -n "${CONTAINER_APP_ID:-}" ] || { echo "n/a"; return; }; (cd "$ROOT" && T2=$(npx wrangler auth token 2>/dev/null | tail -1) && curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $T2" -H 'content-type: application/json' --data '{"query":"query($a:String!){viewer{accounts(filter:{accountTag:$a}){containersMetricsAdaptiveGroups(limit:10,filter:{date_geq:\"'$(date +%Y-%m-01)'\",date_leq:\"'$(date +%Y-%m-%d)'\",applicationId:\"'$CONTAINER_APP_ID'\"}){sum{cpuTimeSec allocatedMemory allocatedDisk}}}}}","variables":{"a":"'$CF_ACCOUNT_ID'"}}' | python3 -c "
import json,sys;s=json.load(sys.stdin)['data']['viewer']['accounts'][0]['containersMetricsAdaptiveGroups'][0]['sum']
print(f\"{s['allocatedMemory']/2**30/3600:.2f} {s['allocatedDisk']/1e9/3600:.2f} {s['cpuTimeSec']/60:.2f}\")"); }
U0=$(usage); ts "usage before (GiB-h mem, GB-h disk, vCPU-min): $U0"

# 1. base repo: 40 files
api -X POST --json '{"description":"stress base: 40 files"}' $U/notagents > na/base.json; j na/base.json repo > repo; j na/base.json fork > bubbleA
push na/base.json w/base 'for i in $(seq -w 0 39); do printf "line1-$i\nline2-$i\nline3-$i\n" > f$i.txt; done' || { ts "base push failed"; exit 1; }
ts "repo $(cat repo), base pushed"; settle || exit 1; ts "base placed"; summary

# 2. 60 notagents in parallel
{ for i in $(seq -w 0 29); do echo "new $i"; done; for i in $(seq -w 0 23); do echo "edit $i"; done; for p in 30 31 32; do echo "conf ${p}a"; echo "conf ${p}b"; done; } | shuf > jobs.txt
ts "pushing $(wc -l < jobs.txt) notagents, 20 at a time"
xargs -P 20 -L 1 bash "$E2E/stress/worker.sh" < jobs.txt
ts "pushes done (503 retries: $(cat retries.log 2>/dev/null | wc -l)): $(grep -c '^ok' pushes.log) ok, $(grep -c '^fail' pushes.log) failed; slowest $(sort -k5 -n pushes.log | tail -1 | awk '{print $5}')s"
for i in $(seq 1 160); do w=$(api $U/repos/$(cat repo) | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['waiting'])+len(d['placing']))"); [ "$w" = 0 ] && break; sleep 15; done
ts "all placed"; summary
settle || exit 1; ts "settled after pushes"; summary

# 3. resolve conflicts one at a time
n=0
while :; do
  pair=$(api $U/repos/$(cat repo) | python3 -c "import json,sys;c=json.load(sys.stdin)['conflicts'];print(' '.join(c[0]) if c else '')")
  [ -z "$pair" ] && break; n=$((n+1)); [ $n -gt 10 ] && { ts "too many ferge rounds"; exit 1; }
  set -- $pair; a=$1; b=$2; [ "$b" = "$(cat bubbleA)" ] && { a=$2; b=$1; }
  api -X POST --json "{\"a\":\"$a\",\"b\":\"$b\"}" $U/repos/$(cat repo)/ferge > na/ferge-$n.json
  L=$(j na/ferge-$n.json locked 2>/dev/null) || { ts "ferge $n failed: $(cat na/ferge-$n.json)"; exit 1; }
  files=$(python3 -c "import json;print(' '.join(json.load(open('na/ferge-$n.json'))['files']))")
  fixcmd=""; for file in $files; do p=${file#f}; p=${p%.txt}; fixcmd="$fixcmd printf 'line1-$p\nresolved-$p\nline3-$p\n' > $file;"; done
  ts "ferge $n: ${a: -8} + ${b: -8} → locked ${L: -8}, conflicting $files"
  api -X POST --json "{\"repo\":\"$(cat repo)\",\"bubble\":\"$L\",\"description\":\"resolve $files\"}" $U/notagents > na/fix-$n.json
  push na/fix-$n.json w/fix-$n "$fixcmd" || { ts "fix push failed"; exit 1; }
  settle || exit 1; ts "fix $n placed and merged"; summary
  api -X POST --json "{\"bubble\":\"$L\"}" $U/repos/$(cat repo)/unlock > /dev/null
  settle || exit 1; ts "unlocked ${L: -8}, settled"; summary
done

# 4. verify the final representative
api $U/repos/$(cat repo) > final.json
R=$(python3 -c "import json;d=json.load(open('final.json'));print(d['bubbles'][0]['id'] if len(d['bubbles'])==1 else '')")
[ -z "$R" ] && { ts "FAIL: expected one bubble"; summary; exit 1; }
tok=$(cd "$ROOT" && npx wrangler artifacts repos issue-token $R --namespace blingo --scope read --json 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['plaintext'].split('?')[0])")
host=$(cmd=$(j na/base.json push); echo "$cmd" | sed -E 's#.*@([^/]+)/.*#\1#')
rm -rf final; git clone -q "https://x:$tok@$host/git/blingo/$R.git" final
bad=0
for i in $(seq -w 0 23); do [ "$(sed -n 1p final/f$i.txt)" = "edited-$i" ] || { echo "  missing edit f$i"; bad=1; }; done
for i in $(seq -w 0 29); do [ "$(cat final/new/n$i.txt 2>/dev/null)" = "new-$i" ] || { echo "  missing new/n$i"; bad=1; }; done
for p in 30 31 32; do [ "$(sed -n 2p final/f$p.txt)" = "resolved-$p" ] || { echo "  f$p line2 = $(sed -n 2p final/f$p.txt)"; bad=1; }; done
grep -rl '^<<<<<<<' final --exclude-dir=.git && { echo "  conflict markers left"; bad=1; }
python3 -c "
import json;d=json.load(open('$D/final.json'))
bad=[m['name'][-8:]+':'+m['status'] for b in d['bubbles'] for m in b['members'] if m['status'] not in ('rep','merged')]
print('  non-merged forks:',bad or 'none','| conflicts:',d['conflicts'] or 'none','| members:',sum(len(b['members']) for b in d['bubbles']))"
ts "verify: $([ $bad = 0 ] && echo PASS || echo FAIL)"
U1=$(usage); ts "usage after: $U1 (before: $U0)"
echo "DONE $bad"
