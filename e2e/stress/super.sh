# Super stress test: run.sh at scale. 1 base + 1797 new files + 100 clean pairs + 1 conflicting pair
# + 1 fix = 2001 notagents, ≥ 100 clean bubble merges, 1 ferge. Pushed in batches so RepoDO polls a few
# hundred loose forks at a time, not 2000. Takes hours; leaves the repo.
export FILES=${FILES:-102} N_NEW=${N_NEW:-1797} N_EDIT=${N_EDIT:-0} N_PAIRS=${N_PAIRS:-100} N_CONF=${N_CONF:-1}
export P=${P:-25} BATCH=${BATCH:-200} SETTLE_MIN=${SETTLE_MIN:-120}
exec bash "$(dirname "$0")/run.sh"
