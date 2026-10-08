# worker.sh <kind> <n>: create a notagent from bubble A and push one change. Logs "ok|fail kind n fork secs".
# Run by run.sh, which exports D (its work dir).
. "$(dirname "$0")/../env.sh"
R=$(cat $D/repo); A=$(cat $D/bubbleA); kind=$1; n=$2; t0=$(date +%s); f=$D/na/$kind-$n.json
tries=0
while :; do  # retry on 503 like a client should
  code=$(api -o $f -w '%{http_code}' -X POST --json "{\"repo\":\"$R\",\"bubble\":\"$A\",\"description\":\"stress $kind $n\"}" $U/notagents)
  [ "$code" = 503 ] && [ $tries -lt 5 ] || break
  tries=$((tries + 1)); echo "503 $kind $n" >> $D/retries.log; sleep 2
done
case $kind in
  new)  edit="mkdir -p new; echo new-$n > new/n$n.txt" ;;
  edit) edit="sed -i '1s/.*/edited-$n/' f$n.txt" ;;
  conf) p=${n%?}; s=${n#??}; edit="sed -i '2s/.*/conflict-$p-$s/' f$p.txt" ;;
esac
if push $f $D/w/$kind-$n "$edit"; then st=ok; else st=fail; fi
echo "$st $kind $n $(j $f fork 2>/dev/null) $(( $(date +%s) - t0 ))" >> $D/pushes.log
