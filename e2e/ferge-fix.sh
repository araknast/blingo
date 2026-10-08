# ferge-fix.sh: two forks conflict on a.txt → ferge → a fix forked from the ferge bubble → unlock.
# Prints the bubbles after each step; at the end A should hold the resolved a.txt and no markers.
. "$(dirname "$0")/env.sh"
S=${WORK:-$(mktemp -d)}; cd "$S"; echo "work dir $S"
show() { api $U/repos/$R | python3 -c "
import json,sys;d=json.load(sys.stdin)
for b in d['bubbles']: print('  bubble',b['id'][-8:],'LOCKED' if b['locked'] else '','' if b['visible'] else 'HIDDEN',[(m['name'][-8:],m['status'],m['files']) for m in b['members']])
print('  conflicts',[[x[-8:] for x in c] for c in d['conflicts']],'waiting',len(d['waiting']))"; }
# settled = nothing waiting for a push, nothing pending, unchanged across two reads 10s apart
settle() { local prev= r; for i in $(seq 1 36); do r=$(api $U/repos/$R); if echo "$r" | grep -q '"waiting":\[\]' && ! echo "$r" | grep -q '"pending"' && [ "$r" = "$prev" ]; then return; fi; prev=$r; sleep 10; done; echo "  (did not settle)"; }
file() { api "$U/repos/$R/$1?path=$2"; }
notagent() { api -X POST --json "$1" $U/notagents; }
notagent '{"description":"base a.txt"}' > x0.json; R=$(j x0.json repo); A=$(j x0.json fork); echo "repo $R  A=${A: -8}"
push x0.json r0 'printf "line1\nline2\nline3\n" > a.txt' >/dev/null; settle
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"add d.txt\"}" > xd.json
push xd.json rd 'echo d > d.txt' >/dev/null; settle
echo "== 0. disjoint fork (d.txt) should join A:"; show
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"ALPHA\"}" > x1.json
notagent "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"BETA\"}" > x2.json
push x1.json r1 'sed -i s/line1/ALPHA/ a.txt; echo alpha > alpha.txt' >/dev/null; settle
push x2.json r2 'sed -i s/line1/BETA/ a.txt; echo beta > beta.txt' >/dev/null; settle
echo "== 1. conflicting bubbles:"; show
B=$(api $U/repos/$R | python3 -c "import json,sys;c=json.load(sys.stdin)['conflicts'][0];print([x for x in c if x!='$A'][0])")
echo "== 2. ferge A + ${B: -8}:"; api -X POST --json "{\"a\":\"$A\",\"b\":\"$B\"}" $U/repos/$R/ferge > ferge.json; cat ferge.json; echo
L=$(j ferge.json locked); show
echo "  ferge bubble a.txt: $(file $L a.txt | tr '\n' '|')"
echo "== 3. notagent from ferge bubble ${L: -8}, resolve a.txt (goes wherever it fits):"
notagent "{\"repo\":\"$R\",\"bubble\":\"$L\",\"description\":\"resolve a.txt\"}" > x3.json; X=$(j x3.json fork)
push x3.json r3 'printf "ALPHA+BETA\nline2\nline3\n" > a.txt' >/dev/null; settle
show
echo "  fix fork ${X: -8} a.txt: $(file $X a.txt | tr '\n' '|')"
echo "== 4. unlock ${L: -8}:"; api -X POST --json "{\"bubble\":\"$L\"}" $U/repos/$R/unlock; echo; settle
show
echo "  A's files:"; for f in a.txt alpha.txt beta.txt; do echo "    $f: $(file $A $f | tr '\n' '|')"; done
echo "== cleanup: $(api -X DELETE $U/repos/$R)"
echo "DONE"
