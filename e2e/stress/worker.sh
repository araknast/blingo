# worker.sh <kind> <n>: create a notagent from bubble A and push one change. Logs "ok|fail kind n fork secs".
# Run by run.sh, which exports D (its work dir) and W (file-number width).
. "$(dirname "$0")/../env.sh"
R=$(cat $D/repo); A=$(cat $D/bubbleA); kind=$1; n=$2; t0=$(date +%s); f=$D/na/$kind-$n.json
tries=0
while :; do  # retry on 503 like a client should (a failed request leaves no task behind)
  code=$(api -o $f -w '%{http_code}' -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"stress $kind $n\"}" $U/notagents)
  [ "$code" = 503 ] && [ $tries -lt 5 ] || break
  tries=$((tries + 1)); echo "503 $kind $n" >> $D/retries.log; sleep 2
done
p=${n%?}; s=${n: -1}  # conf/pair: file number, then side a or b
case $kind in
  new)  edit="mkdir -p new; echo new-$n > new/n$n.txt" ;;
  edit) edit="sed -i '1s/.*/edited-$n/' f$n.txt" ;;
  pair) [ $s = a ] && edit="sed -i '1s/.*/pair-$p-a/' f$p.txt" || edit="sed -i '3s/.*/pair-$p-b/' f$p.txt" ;;
  conf) edit="sed -i '2s/.*/conflict-$p-$s/' f$p.txt" ;;
esac
# A failed push is retried on the same fork (a new token if needed): its task must still complete.
st=fail
for i in 1 2 3; do
  push $f $D/w/$kind-$n "$edit" && { st=ok; break; }
  echo "push $kind $n" >> $D/retries.log; sleep 5
  fork=$(j $f fork 2>/dev/null) || break
  api -X POST $U/repos/$R/forks/$fork/token > $f.tok && python3 -c "
import json;t=json.load(open('$f.tok'));d=json.load(open('$f'))
if 'push' in t: d['push']=t['push']; json.dump(d,open('$f','w'))" 2>/dev/null
done
echo "$st $kind $n $(j $f fork 2>/dev/null) $(( $(date +%s) - t0 ))" >> $D/pushes.log
