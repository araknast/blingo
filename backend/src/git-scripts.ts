// The git jobs (and the agents' memory hook) blingo runs in Box containers, as bash scripts. Pure
// strings, so test/git-scripts.test.ts can run them against local repos.

// A fork's patch series. $1 its clone (a directory) or remote, $2 the commit it started from ("" = the
// empty base repository). Prints the files it changed, a "==" line, then `git format-patch` of its
// commits (an mbox, as git send-email would send them). Prints nothing if it committed nothing.
// Exit MERGES = its history has merge commits, which format-patch can't carry.
export const MERGES = 4;
export const PATCH_SH = `set -e
if [ -d "$1" ]; then cd "$1"; else d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; git clone -q "$1" "$d"; cd "$d"; fi
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
[ -d ${REP}/.git ] || { rm -rf ${REP}; git clone -q "$1" ${REP}; }
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
git clone -q "$1" "$t"; cd "$t"
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
git clone -q "$1" "$t"; git fetch -q "$t" HEAD
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
git clone -q "$1" "$src"; git fetch -q "$src" HEAD; b=$(git rev-parse FETCH_HEAD)
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
