// The git jobs (and the agents' memory hook) blingo runs in Box containers, as bash scripts. Pure
// strings, so test/git-scripts.test.ts can run them against local repos.

// A fork's patch series. $1 its clone (a directory) or remote, $2 the commit it started from ("" = the
// empty base repository). Prints the files it changed, a "==" line, then `git format-patch` of its
// commits (an mbox, as git send-email would send them). Prints nothing if it committed nothing.
// Exit MERGES = its history has merge commits, which format-patch can't carry.
export const MERGES = 4;
export const PATCH_SH = `set -e
if [ -d "$1" ]; then cd "$1"; else d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; git clone -q --single-branch "$1" "$d"; cd "$d"; fi
git rev-parse -q --verify HEAD >/dev/null || exit 0
[ -z "$(git rev-list --merges "\${2:+$2..}HEAD")" ] || exit ${MERGES}
if [ -n "$2" ]; then from=$2; range="$2..HEAD"; else from=$(git hash-object -t tree /dev/null); range="--root HEAD"; fi
git diff --name-only "$from" HEAD
echo ==
git format-patch --stdout --binary $range`;

export function readSeries(out: string): { files: string[]; mbox: string } {
	const i = out.search(/^==$/m);
	return i < 0 ? { files: [], mbox: "" } : { files: out.slice(0, i).split("\n").filter(Boolean), mbox: out.slice(i + 3) };
}

// A bubble Box's clone of its representative, at REP. The Box is the rep's only writer, so the clone
// is never fetched: it is made fresh when the container is new (or after a failed job) and pushed to.
// That also avoids incremental fetches from Artifacts, which intermittently fail to negotiate.
// $1 rep remote (write); the job's own arguments follow.
export const REP = "/workspace/rep";
export const ENSURE_REP = `set -e
[ -d ${REP}/.git ] || { rm -rf ${REP}; git clone -q --single-branch "$1" ${REP}; }
cd ${REP}; git remote set-url origin "$1"; shift
`;

// Exit code of a job whose git work conflicted; the clone is left as it was.
export const CONFLICT = 3;

// stdin: one fork's patch series. Applies it on top of the rep (authors from the patches, committer
// from the environment); if it doesn't apply, nothing of it is kept.
export const APPLY_SH = `m=$(mktemp); cat > "$m"
git am -q --3way "$m" >&2 || { git am --abort 2>/dev/null || true; exit ${CONFLICT}; }`;

export const PUSH_SH = `git push -q origin HEAD:refs/heads/main`;

// A person's files, committed for them (the ferge resolver). $1 fork remote (write), $2 commit message;
// stdin: {"path": "content", ...} (paths relative, no ".."). Exit 1 = a bad path or nothing changed.
export const COMMIT_FILES_SH = `set -e
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
git clone -q --single-branch "$1" "$t"; cd "$t"
node -e '
const fs = require("fs"), path = require("path");
for (const [p, text] of Object.entries(JSON.parse(fs.readFileSync(0, "utf8")))) {
	if (!p || path.isAbsolute(p) || p.split("/").some((s) => s === ".." || s === ".git")) throw new Error("bad path: " + p);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
}'
git add -A
git commit -qm "$2"
git push -q origin HEAD:refs/heads/main`;

// $1 source remote (read): a neighbour bubble's rep, or a fork from before patch series. Merges it
// into the rep with a merge commit and pushes; prints the source's diff since their merge base.
// It is cloned and then fetched from the local copy, never fetched incrementally from Artifacts.
export const MERGE_SH = `t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
git clone -q --single-branch "$1" "$t"; git fetch -q "$t" HEAD
base=$(git rev-parse HEAD)
if ! git merge -q --no-ff --no-edit --allow-unrelated-histories -m "$2" FETCH_HEAD >&2; then
	git merge --abort 2>/dev/null || git reset -q --hard "$base"; exit ${CONFLICT}
fi
${PUSH_SH}
git diff "$(git merge-base "$base" FETCH_HEAD || git hash-object -t tree /dev/null)" FETCH_HEAD`;

export const NO_CONFLICT = 11;

// Ferge, in bubble A's Box. $1 bubble B rep (read), $2 new locked bubble L (write, a fork of A).
// A ← A + B with the conflicting files removed (one squashed commit, history stays linear).
// L ← that + the conflicting files with conflict markers. Prints the conflicting files, a "==" line,
// then every file in L's tree (L's file set: everything it carries since the repo's starting point).
// Exit ${NO_CONFLICT} = A and B no longer conflict; anything else nonzero = infra error.
export const FERGE_SH = `m=$(mktemp -d); src=$(mktemp -d); trap 'rm -rf "$m" "$src"' EXIT
a=$(git rev-parse HEAD)
git clone -q --single-branch "$1" "$src"; git fetch -q "$src" HEAD; b=$(git rev-parse FETCH_HEAD)
mt() { git merge-tree --write-tree --no-messages --allow-unrelated-histories "$@"; }
out=$(mt --name-only "$a" "$b") && rc=0 || rc=$?
[ "$rc" -le 1 ] || exit "$rc"
F=$(printf '%s\\n' "$out" | tail -n +2)
[ -n "$F" ] || exit ${NO_CONFLICT}
# Capture each conflicting file as git leaves it mid-merge: with conflict markers.
git -c merge.conflictStyle=merge merge -q --no-commit --no-ff --allow-unrelated-histories "$b" >/dev/null 2>&1 || true
printf '%s\\n' "$F" | while IFS= read -r f; do
	if [ -e "$f" ]; then mkdir -p "$m/$(dirname "$f")"; cp "$f" "$m/$f"; fi
done
git merge --abort 2>/dev/null || git reset -q --hard "$a"
drop() {
	git checkout -q --detach "$1"
	printf '%s\\n' "$F" | git --literal-pathspecs rm -q --ignore-unmatch --pathspec-from-file=-
	git commit -q --allow-empty -m "ferge: remove conflicting files"
	git rev-parse HEAD
}
ap=$(drop "$a"); bp=$(drop "$b")
t=$(mt "$ap" "$bp") # its own assignment, so set -e catches a failed merge
c=$(git commit-tree "$t" -p "$ap" -m "ferge: merge $b without conflicting files")
git push -q origin "$c:refs/heads/main"
git checkout -q --detach "$c"
cp -R "$m/." .
git add -A
git commit -q --allow-empty -m "ferge: conflicting files with conflict markers"
git push -q "$2" HEAD:refs/heads/main
printf '%s\\n' "$F" ==
git ls-files
git checkout -q --detach "$c" # the clone stays A's rep`;

// Claude Code's PostToolBatch hook (it runs before each model request after the first): $1 the task
// directory. When RepoDO has written new memory items to $1/memory.md (Box.pushMemory), it hands them
// to the model once as additional context. The first request already has memory in the system prompt.
export const MEMORY_HOOK_SH = `f="$1/memory.md"; seen="$1/.memory-seen"
[ -f "$f" ] || exit 0
h=$(sha1sum "$f" | cut -c1-40)
[ "$h" = "$(cat "$seen" 2>/dev/null)" ] && exit 0
echo "$h" > "$seen"
node -e 'process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolBatch", additionalContext: "Repository memory was updated. It now holds:\\n" + require("fs").readFileSync(process.argv[1], "utf8") } }))' "$f"`;

// ---- a repository's environment: the `env` branch ----
// `env` holds what agents installed in the container (a tree rooted at /, e.g. usr/bin/jq), so a fork
// carries its basis's toolchains. The project is `main`; nothing else reads `env`. Files over the
// Artifacts 32 MB limit are stored as <path>.blingo-part-NNN chunks.
// ENV_GIT: ArtifactFS's git dir (blobless: trees here, blobs fetched on read). ENV_OVL: the overlays'
// upper dirs (<dir>/u). Both sit outside the overlaid dirs, so the Box sees them from outside the
// agent's mount namespace. ENV_ROOT and ENV_CHUNK are for tests.
export const ENV_GIT = "/afs/env.git";
export const ENV_DIRS = "bin etc home lib opt root sbin srv usr var";

// $1 the fork's remote. In the Box's own mount namespace: mounts the fork's env at /mnt/env with
// ArtifactFS (its daemon serves file contents on first read), or starts an empty env git dir when the
// fork has none. If the mount fails the git dir is removed, so nothing is saved over the env.
export const ENV_MOUNT_SH = `set -e
G=${ENV_GIT}; A=$(dirname $G); rm -rf "$A"; mkdir -p "$A" /ovl
rc=0; git ls-remote -q --exit-code "$1" refs/heads/env >/dev/null || rc=$?
if [ $rc = 2 ]; then git init -q --bare "$G"; exit 0; fi # no env yet
if [ $rc = 0 ] && artifact-fs add-repo --name env --remote "$1" --ref refs/heads/env --git-dir "$G" --mount-root /mnt >"$A/add.log" 2>&1; then
	# ArtifactFS uses the remote's token only to clone; reads need it from git's own credentials.
	printf '%s\\n' "$1" >"$A/cred"; git --git-dir="$G" config credential.helper "store --file=$A/cred"
	setsid artifact-fs daemon --root /mnt >"$A/daemon.log" 2>&1 </dev/null &
	for i in $(seq 120); do mountpoint -q /mnt/env && exit 0; sleep 0.5; done
fi
cat "$A"/*.log >&2 || true; rm -rf "$G"; exit 1`;

// Run first inside the job's private mount namespace (BG_SH). Each of ENV_DIRS becomes an overlay: the
// image below, the env above it, writes into /ovl/<dir>/u. Only that namespace sees it; the daemon
// stays outside, since its own git would otherwise wait on the mount it serves. Bind mounts under a
// dir (/etc/hosts, /etc/resolv.conf: the container's networking) are put back on top. Then chunked
// files are joined. No env git dir (no mount): nothing to do. Upper dirs can't be on overlayfs (local
// Docker's root; Cloudflare's is btrfs), so there they go on a tmpfs. A dir that won't mount is left
// out: the job still runs, without its env.
export const ENV_OVERLAY_SH = `if [ -d ${ENV_GIT} ]; then
[ "$(findmnt -n -o FSTYPE -T /ovl)" != overlay ] || mount -t tmpfs tmpfs /ovl
for D in ${ENV_DIRS}; do
	mkdir -p /ovl/$D/u /ovl/$D/w /$D
	L=/$D; if mountpoint -q /mnt/env && [ -d /mnt/env/$D ]; then L=/mnt/env/$D:/$D; fi
	keep=$(findmnt -rn -o TARGET | grep "^/$D/" || true)
	for m in $keep; do k=/ovl/keep$m; mkdir -p "$(dirname $k)"; if [ -d $m ]; then mkdir -p $k; else touch $k; fi; mount --bind $m $k; done
	mount -t overlay overlay -o lowerdir=$L,upperdir=/ovl/$D/u,workdir=/ovl/$D/w /$D || echo "blingo: no env overlay on /$D" >&2
	for m in $keep; do mount --bind /ovl/keep$m $m; done
done
if git --git-dir=${ENV_GIT} rev-parse -q --verify HEAD >/dev/null; then
	git --git-dir=${ENV_GIT} ls-tree -r --name-only HEAD | grep '\\.blingo-part-000$' | while IFS= read -r p; do
		f=/\${p%.blingo-part-000}; cat "$f".blingo-part-* >"$f" && chmod --reference="/$p" "$f" && rm -f "$f".blingo-part-*
	done
fi
fi
`;

// After the run, inside its namespace: the env with this run's changes, as a commit on the last env at
// refs/blingo/env in ENV_GIT (the Box pushes it). The changes are what the upper dirs hold: files and
// symlinks are added from the merged view, and whiteouts, plus what an opaque or deleted dir hid, are
// removed. Unchanged env files are never read, so they stay unfetched. The parent lets the push send
// only new objects (a parentless tree would be sent whole, blobs this clone never fetched included).
// ponytail: paths with tabs or newlines are skipped; ownership, setuid bits and empty dirs aren't kept;
// env history only grows (storage is billed per GB), squash it if that bites.
export const ENV_SAVE_SH = `set -e
export GIT_DIR=\${ENV_GIT:-${ENV_GIT}}; [ -d "$GIT_DIR" ] || exit 0
W=\${ENV_ROOT:-/}; O=\${ENV_OVL:-/ovl}; C=\${ENV_CHUNK:-32505856}
export GIT_WORK_TREE=$W GIT_INDEX_FILE=$GIT_DIR/env.index
cd "$W" # paths are taken from here
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
rm -f "$GIT_INDEX_FILE"; if git rev-parse -q --verify HEAD >/dev/null; then git read-tree HEAD; fi
for D in ${ENV_DIRS}; do [ -d "$O/$D/u" ] && (cd "$O/$D/u" && find . -mindepth 1 -printf "$D/%P\\t%y\\t%s\\n"); done |
	grep -Ev '^(etc/(hosts|resolv\\.conf|hostname|cloudflare)|root/\\.claude|root/\\.claude\\.json|root/\\.cache|root/\\.npm|var/cache|var/tmp)(/|[[:space:]])' >"$t/up" || true
# Gone: whiteouts, and what a dir in the upper layer no longer shows (an opaque or deleted dir).
{ awk -F'\\t' '$2 == "c" { print $1 }' "$t/up"
  git ls-files | awk -F'\\t' 'NR == FNR { if ($2 == "d" || $2 == "c") s[$1] = 1; next }
	{ p = $0; while ((i = match(p, "/[^/]*$")) > 0) { p = substr(p, 1, i - 1); if (p in s) { print $0; break } } }' "$t/up" - |
	while IFS= read -r p; do [ -e "$W/$p" ] || [ -L "$W/$p" ] || printf '%s\\n' "$p"; done
  awk -F'\\t' '$2 == "f" && $3 > '"$C"' { print $1 }' "$t/up"
} | tr '\\n' '\\0' | git update-index -z --force-remove --stdin
awk -F'\\t' '$2 == "l" || ($2 == "f" && $3 <= '"$C"') { print $1 }' "$t/up" | tr '\\n' '\\0' | git update-index -z --add --replace --stdin
awk -F'\\t' '$2 == "f" && $3 > '"$C"' { print $1 }' "$t/up" | while IFS= read -r p; do
	M=100644; [ -x "$W/$p" ] && M=100755
	P=$p M=$M split -b "$C" -d -a 3 --filter='printf "%s %s\\t%s.blingo-part-%s\\n" "$M" "$(git hash-object -w --stdin)" "$P" "\${FILE#x.}"' "$W/$p" x.
done | git update-index --index-info
p=$(git rev-parse -q --verify HEAD) || true
c=$(git commit-tree \${p:+-p "$p"} -m env "$(git write-tree --missing-ok)")
git update-ref refs/blingo/env "$c"`;

// In a bubble's Box, when code merges into its rep (a member's series applied, a neighbour or ferge
// absorbed): $1 the rep's remote (write), then the remotes (read) whose envs merge into the rep's, in
// order. Blobless throughout: of the sources, only the objects the rep lacks are fetched, by id and in
// one request (no "haves", so not the incremental fetch Artifacts fails on). A path both sides changed
// keeps both sides' lines when it's text (lib/apk/db/installed then lists both's packages), else the
// incoming side's version. No env at a source: skipped.
export const ENV_MERGE_SH = `set -e
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
git clone -q --bare --filter=blob:none "$1" "$t/w"; cd "$t/w"; shift
export GIT_INDEX_FILE=$t/index
start=$(git rev-parse -q --verify refs/heads/env || true); e=$start; n=0
bin() { [ "$(tr -d '\\000' <"$1" | wc -c)" != "$(wc -c <"$1")" ]; }
# apk's db is blank-line-separated records, which a line union glues together: merge it by record
# (base incoming ours): ours minus what the incoming side removed, then the incoming side's new ones.
recs() { awk 'BEGIN { RS = ""; ORS = "\\n\\n" } FILENAME == ARGV[1] { b[$0] = 1; next } FILENAME == ARGV[2] { s[$0] = 1; k[++n] = $0; next }
	{ o[$0] = 1; if (!($0 in b) || ($0 in s)) print } END { for (i = 1; i <= n; i++) if (!(k[i] in b) && !(k[i] in o)) print k[i] }' "$@"; }
for S in "$@"; do
	n=$((n + 1)); s=$t/s$n
	git clone -q --bare --filter=blob:none --single-branch -b env "$S" "$s" 2>/dev/null || continue
	git -C "$s" config uploadpack.allowFilter true
	git remote add "s$n" "$s"; git fetch -q --filter=blob:none "s$n" +refs/heads/env:refs/src
	src=$(git rev-parse refs/src)
	if [ -n "$e" ] && git merge-base --is-ancestor "$src" "$e"; then continue; fi
	git rev-list --objects --missing=print "$src" \${e:+--not "$e"} | sed -n 's/^?//p' >"$t/want"
	[ ! -s "$t/want" ] || git -c fetch.negotiationAlgorithm=noop fetch -q --no-write-fetch-head --stdin "$S" <"$t/want"
	if [ -z "$e" ] || git merge-base --is-ancestor "$e" "$src"; then e=$src; continue; fi
	out=$(git merge-tree --write-tree --name-only --no-messages --allow-unrelated-histories "$e" "$src") && rc=0 || rc=$?
	[ "$rc" -le 1 ] || exit "$rc"
	git read-tree "$(printf '%s\\n' "$out" | head -1)"
	b=$(git merge-base "$e" "$src" || true)
	printf '%s\\n' "$out" | tail -n +2 | sort -u | while IFS= read -r p; do
		[ -n "$p" ] || continue
		set -- $(git ls-tree "$src" -- "$p")
		if [ $# = 0 ]; then git update-index --force-remove -- "$p"; continue; fi
		[ "$2" = blob ] || continue
		m=$1; o=$(git rev-parse -q --verify "$e:$p" || true)
		if [ "$m" != 120000 ] && [ -n "$o" ] && [ "$(git cat-file -t "$o")" = blob ]; then
			git cat-file blob "$o" >"$t/o"; git cat-file blob "$3" >"$t/s"
			git cat-file blob "$b:$p" >"$t/b" 2>/dev/null || : >"$t/b"
			if ! bin "$t/o" && ! bin "$t/s"; then
				if [ "$p" = lib/apk/db/installed ]; then recs "$t/b" "$t/s" "$t/o" >"$t/m"; else git merge-file --union -p "$t/o" "$t/b" "$t/s" >"$t/m" || true; fi
				git update-index --add --cacheinfo "$m,$(git hash-object -w "$t/m"),$p"; continue
			fi
		fi
		git update-index --add --cacheinfo "$m,$3,$p"
	done
	e=$(git commit-tree "$(git write-tree --missing-ok)" -p "$e" -p "$src" -m "env: merge")
done
[ "$e" != "$start" ] || exit 0
GIT_NO_LAZY_FETCH=1 git -c pack.window=0 push -q --no-thin origin "$e:refs/heads/env"`;

// From the Box after the run: $1 the fork's remote (write). Only objects the fork lacks are sent; a
// lazy fetch is refused rather than made (every object pushed was written here). No deltas and not a
// thin pack: both read the old env's (unfetched) version of a changed file as a base. Over Artifacts'
// HTTP even --no-thin does (ENV_MERGE_SH's push too); pack.window=0 stops it.
export const ENV_PUSH_SH = `export GIT_DIR=\${ENV_GIT:-${ENV_GIT}}
git rev-parse -q --verify refs/blingo/env >/dev/null || exit 0
GIT_NO_LAZY_FETCH=1 git -c pack.window=0 push -qf --no-thin "$1" refs/blingo/env:refs/heads/env`;
