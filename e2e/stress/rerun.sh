# rerun.sh: run.sh with `wrangler tail` of both Workers capturing errors into the work dir.
. "$(dirname "$0")/../env.sh"
export D=${WORK:-$(mktemp -d)}; mkdir -p "$D" || exit 1; echo "work dir $D"; cd "$ROOT"
for w in blingo yorkle; do npx wrangler tail $w --format json --status error --status canceled > $D/tail-$w.json 2> $D/tail-$w.err & echo $! >> $D/tail.pids; done
sleep 10; echo "tails started" > $D/run.log
bash "$E2E/stress/run.sh" >> $D/run.log 2>&1; echo "exit $?" >> $D/run.log
kill $(cat $D/tail.pids) 2>/dev/null; rm -f $D/tail.pids
