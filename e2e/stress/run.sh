# Stress test: a FILES-file repo, then notagents pushed P at a time in batches of BATCH: N_NEW new files,
# N_EDIT edits, N_PAIRS pairs editing lines 1 and 3 of one file (the second of each starts a bubble that
# merges back cleanly) and N_CONF conflicting pairs; ferge + fix + unlock each conflict, then check
# everything reached one bubble and every task completed. Defaults: 40 files, 60 notagents (super.sh: 2000).
# Optional: CF_ACCOUNT_ID and CONTAINER_APP_ID for container usage before/after.
. "$(dirname "$0")/../env.sh"
FILES=${FILES:-40} N_NEW=${N_NEW:-30} N_EDIT=${N_EDIT:-24} N_PAIRS=${N_PAIRS:-0} N_CONF=${N_CONF:-3}
P=${P:-20} BATCH=${BATCH:-1000000} SETTLE_MIN=${SETTLE_MIN:-40}
[ $((N_EDIT + N_PAIRS + N_CONF)) -le "$FILES" ] || { echo "N_EDIT + N_PAIRS + N_CONF must be at most FILES"; exit 1; }
export W=${#FILES} NW=${#N_NEW}; num() { printf "%0${1}d" "$2"; }
export D=${D:-${WORK:-$(mktemp -d)}}; echo "work dir $D"
set -u; mkdir -p "$D" && cd "$D" || exit 1; rm -rf na w pushes.log retries.log; mkdir -p na w
T0=$(date +%s); ts() { echo "[$(( $(date +%s) - T0 ))s] $*"; }
summary() { api $U/repos/$(cat repo) | python3 -c "
import json,sys,collections;d=json.load(sys.stdin)
st=collections.Counter(m['status'] for b in d['bubbles'] for m in b['members'])
print('   bubbles',len(d['bubbles']),'| visible',sum(b['visible'] for b in d['bubbles']),'| locked',sum(b['locked'] for b in d['bubbles']),'| forks',dict(st),'| conflicts',len(d['conflicts']),'| waiting',len(d['waiting']),'| placing',len(d['placing']))"; }
# settle: nothing waiting/pending and two reads 15s apart identical; SETTLE_MIN cap
settle() { local prev= r i; for i in $(seq 1 $((SETTLE_MIN * 4))); do r=$(api $U/repos/$(cat repo)); if echo "$r" | grep -q '"waiting":\[\]' && echo "$r" | grep -q '"placing":\[\]' && ! echo "$r" | grep -q '"pending"' && [ "$r" = "$prev" ]; then return 0; fi; prev=$r; sleep 15; done; ts "SETTLE TIMEOUT"; summary; return 1; }
# placed: every pushed fork has been seen and placed (merges may still be running)
placed() { local i w; for i in $(seq 1 $((SETTLE_MIN * 4))); do w=$(api $U/repos/$(cat repo) | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['waiting'])+len(d['placing']))"); [ "$w" = 0 ] && return 0; sleep 15; done; ts "PLACE TIMEOUT"; return 1; }
usage() { [ -n "${CF_ACCOUNT_ID:-}" ] && [ -n "${CONTAINER_APP_ID:-}" ] || { echo "n/a"; return; }; (cd "$ROOT" && T2=$(npx wrangler auth token 2>/dev/null | tail -1) && curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $T2" -H 'content-type: application/json' --data '{"query":"query($a:String!){viewer{accounts(filter:{accountTag:$a}){containersMetricsAdaptiveGroups(limit:10,filter:{date_geq:\"'$(date +%Y-%m-01)'\",date_leq:\"'$(date +%Y-%m-%d)'\",applicationId:\"'$CONTAINER_APP_ID'\"}){sum{cpuTimeSec allocatedMemory allocatedDisk}}}}}","variables":{"a":"'$CF_ACCOUNT_ID'"}}' | python3 -c "
import json,sys;s=json.load(sys.stdin)['data']['viewer']['accounts'][0]['containersMetricsAdaptiveGroups'][0]['sum']
print(f\"{s['allocatedMemory']/2**30/3600:.2f} {s['allocatedDisk']/1e9/3600:.2f} {s['cpuTimeSec']/60:.2f}\")"); }
U0=$(usage); ts "usage before (GiB-h mem, GB-h disk, vCPU-min): $U0"

# Files 0..N_EDIT-1 get edits, the next N_PAIRS get pairs, the next N_CONF get conflicting pairs.
EDITS=$(for i in $(seq 0 $((N_EDIT - 1))); do num $W $i; echo; done)
PAIRS=$(for i in $(seq $N_EDIT $((N_EDIT + N_PAIRS - 1))); do num $W $i; echo; done)
CONFS=$(for i in $(seq $((N_EDIT + N_PAIRS)) $((N_EDIT + N_PAIRS + N_CONF - 1))); do num $W $i; echo; done)

# 1. base repo: FILES files
api -X POST --json "{\"description\":\"stress base: $FILES files\"}" $U/notagents > na/base.json; j na/base.json repo > repo; j na/base.json fork > bubbleA
push na/base.json w/base "for i in \$(seq 0 $((FILES - 1))); do i=\$(printf %0${W}d \$i); printf \"line1-\$i\nline2-\$i\nline3-\$i\n\" > f\$i.txt; done" || { ts "base push failed"; exit 1; }
ts "repo $(cat repo), base pushed"; settle || exit 1; ts "base placed"; summary

# 2. notagents in parallel, in batches
{ for i in $(seq 0 $((N_NEW - 1))); do echo "new $(num $NW $i)"; done; for i in $EDITS; do echo "edit $i"; done
  for p in $PAIRS; do echo "pair ${p}a"; echo "pair ${p}b"; done; for p in $CONFS; do echo "conf ${p}a"; echo "conf ${p}b"; done; } | shuf > jobs.txt
JOBS=$(wc -l < jobs.txt); ts "pushing $JOBS notagents, $P at a time, $BATCH per batch"
split -l $BATCH -d -a 4 jobs.txt batch.
for b in batch.*; do
  xargs -P $P -L 1 bash "$E2E/stress/worker.sh" < $b
  ts "$b pushed ($(grep -c '^ok' pushes.log) ok, $(grep -c '^fail' pushes.log) failed so far)"; placed || exit 1; ts "$b placed"; summary
done; rm -f batch.*
ts "pushes done (retries: $(cat retries.log 2>/dev/null | wc -l)): $(grep -c '^ok' pushes.log) ok, $(grep -c '^fail' pushes.log) failed; slowest $(sort -k5 -n pushes.log | tail -1 | awk '{print $5}')s"
settle || exit 1; ts "settled after pushes"; summary

# 3. resolve conflicts one at a time
n=0
while :; do
  pair=$(api $U/repos/$(cat repo) | python3 -c "import json,sys;c=json.load(sys.stdin)['conflicts'];print(' '.join(c[0]) if c else '')")
  [ -z "$pair" ] && break; n=$((n+1)); [ $n -gt $((N_CONF + 10)) ] && { ts "too many ferge rounds"; exit 1; }
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
for i in $EDITS; do [ "$(sed -n 1p final/f$i.txt)" = "edited-$i" ] || { echo "  missing edit f$i"; bad=1; }; done
for i in $(seq 0 $((N_NEW - 1))); do i=$(num $NW $i); [ "$(cat final/new/n$i.txt 2>/dev/null)" = "new-$i" ] || { echo "  missing new/n$i"; bad=1; }; done
for p in $PAIRS; do [ "$(sed -n 1p final/f$p.txt) $(sed -n 3p final/f$p.txt)" = "pair-$p-a pair-$p-b" ] || { echo "  f$p pair = $(sed -n 1p final/f$p.txt) $(sed -n 3p final/f$p.txt)"; bad=1; }; done
for p in $CONFS; do [ "$(sed -n 2p final/f$p.txt)" = "resolved-$p" ] || { echo "  f$p line2 = $(sed -n 2p final/f$p.txt)"; bad=1; }; done
grep -rl '^<<<<<<<' final --exclude-dir=.git && { echo "  conflict markers left"; bad=1; }
merges=$(git -C final log --grep='^merge bubble$' --oneline | wc -l)
# Conflicting bubbles can merge with each other first, so N_CONF pairs take 1 to N_CONF ferges.
echo "  clean bubble merges: $merges (want ≥ $N_PAIRS) | ferges: $n (want 1 to $N_CONF)"
[ "$merges" -ge "$N_PAIRS" ] && [ "$n" -ge $((N_CONF > 0)) ] && [ "$n" -le "$N_CONF" ] || bad=1
python3 -c "
import json;d=json.load(open('$D/final.json'))
bad=[m['name'][-8:]+':'+m['status'] for b in d['bubbles'] for m in b['members'] if m['status'] not in ('rep','merged')]
print('  non-merged forks:',bad or 'none','| conflicts:',d['conflicts'] or 'none','| members:',sum(len(b['members']) for b in d['bubbles']))"
tasks_done $(cat repo) || bad=1
nt=$(python3 -c "import json;print(sum(t['kind']=='notagent' for t in json.load(open('$D/final.json'))['tasks']))")
echo "  notagent tasks: $nt (want ≥ $((JOBS + 1 + n)))"; [ "$nt" -ge $((JOBS + 1 + n)) ] || bad=1
ts "verify: $([ $bad = 0 ] && echo PASS || echo FAIL)"
U1=$(usage); ts "usage after: $U1 (before: $U0)"
echo "DONE $bad"
