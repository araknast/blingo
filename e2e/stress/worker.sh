# worker.sh <kind> <n>: create notagents and push their changes. Logs one "ok|fail kind n fork secs"
# line per notagent. A pair (or conflicting pair) is both sides from the same bubble, both created
# before either pushes, so the second can't go home and starts its own bubble.
# Run by run.sh, which exports D (its work dir; `bubbles` there lists the bubbles to fork from).
. "$(dirname "$0")/../env.sh"
R=$(cat $D/repo); kind=$1; n=$2
# A pair forks from bubble A (it outlives every merge, and its record holds every base file), so its
# second side can't land anywhere clean and starts a bubble; the rest fork from all over the map.
case $kind in pair|conf) B=$(cat $D/bubbleA) ;; *) B=$(shuf -n 1 $D/bubbles 2>/dev/null || cat $D/bubbleA) ;; esac

# make <name>: a notagent from bubble B (any bubble once B has merged away), into na/<name>.json.
make() {
  local f=$D/na/$1.json tries=0 code
  while :; do  # retry on 503 like a client should (a failed request leaves no task behind)
    code=$(api -o $f -w '%{http_code}' -X POST --json "{\"repo\":\"$R\"${B:+,\"bubble\":\"$B\"},\"description\":\"stress $1\"}" $U/notagents)
    [ "$code" = 404 ] && [ -n "$B" ] && { B=; continue; }
    [ "$code" = 503 ] && [ $tries -lt 5 ] || break
    tries=$((tries + 1)); echo "503 $1" >> $D/retries.log; sleep 2
  done
}

# send <name> <edit>: push the edit to na/<name>.json's fork. A failed push is retried on the same fork
# (a new token if needed): its task must still complete.
send() {
  local f=$D/na/$1.json t0=$(date +%s) st=fail fork i
  for i in 1 2 3; do
    push $f $D/w/$1 "$2" && { st=ok; break; }
    echo "push $1" >> $D/retries.log; sleep 5
    fork=$(j $f fork 2>/dev/null) || break
    api -X POST $U/repos/$R/forks/$fork/token > $f.tok && python3 -c "
import json;t=json.load(open('$f.tok'));d=json.load(open('$f'))
if 'push' in t: d['push']=t['push']; json.dump(d,open('$f','w'))" 2>/dev/null
  done
  echo "$st ${1%%-*} ${1#*-} $(j $f fork 2>/dev/null) $(( $(date +%s) - t0 ))" >> $D/pushes.log
}

case $kind in
  new)  make new-$n; send new-$n "mkdir -p new; echo new-$n > new/n$n.txt" ;;
  edit) make edit-$n; send edit-$n "sed -i '1s/.*/edited-$n/' f$n.txt" ;;
  pair) make pair-${n}a; make pair-${n}b
        send pair-${n}a "sed -i '1s/.*/pair-$n-a/' f$n.txt"; send pair-${n}b "sed -i '3s/.*/pair-$n-b/' f$n.txt" ;;
  conf) make conf-${n}a; make conf-${n}b
        send conf-${n}a "sed -i '2s/.*/conflict-$n-a/' f$n.txt"; send conf-${n}b "sed -i '2s/.*/conflict-$n-b/' f$n.txt" ;;
esac
