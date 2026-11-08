#!/bin/sh
# The fork's sync with upstream (FORK.md, "Syncing with upstream"): merges upstream's main into a
# `sync/upstream-<version>` branch made from the fork's 3.x line, in a worktree of its own, runs the fork's checks and
# opens a pull request to 3.x. `renix full` runs it in the dev shell (flake.nix) and merges the pull request. By hand:
#   nix develop --command sh scripts/sync-upstream.sh              fetch, merge, check, push, open the pull request
#   nix develop --command sh scripts/sync-upstream.sh --no-pr      the same, but push and open nothing
#   nix develop --command sh scripts/sync-upstream.sh --continue --dir <worktree>   after resolving or fixing there
# Options: --ref <upstream ref> (default upstream/main), --base <fork ref> (default origin/3.x), --dir <worktree>.
# --continue merges the upstream commit the first run saved (in <worktree's git dir>/sync-upstream), whatever --ref says.
# Exit: 0 done or nothing new, 1 an error, 3 conflicts to resolve, 4 the check failed. Never pushes to upstream.
set -e
say() { printf 'sync-upstream: %s\n' "$*" >&2; }
die() { say "$1"; exit "${2:-1}"; }
UPSTREAM_URL="https://github.com/eliasstravik/shepherdr.git"
script=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")

# The fork's checks in the current folder (the sync worktree), which the script runs at the lowest priority after the
# merge: what CI's Check workflow builds on (dependencies, generated plugin list, types, the shared copies), the Python
# tests (the repo's rules, the installer, herdr-task, the layer's own), the layer's Bun tests (the test files FORK.md's
# table names) and the layer itself (scripts/fork_layer.py: every file it names is there, every hook keeps its `fork:`
# comment). Not the whole Bun suite and the build: GitHub's Check workflow runs those. SHEPHERDR_SYNC_CHECK, a shell
# command, replaces all of it (test/test_sync_upstream.py).
run_checks() {
  if [ -n "${SHEPHERDR_SYNC_CHECK:-}" ]; then exec sh -c "$SHEPHERDR_SYNC_CHECK"; fi
  set -x
  python3 scripts/fork_layer.py check
  bun install --frozen-lockfile --no-progress
  bun web/build-plugins.ts
  bun run typecheck
  python3 bin/sync-shared --check
  python3 -m unittest discover -s test
  # shellcheck disable=SC2046
  bun test $(python3 scripts/fork_layer.py tests | sed 's#^#./#')
  exit 0
}
# The fork's branch this script syncs and opens pull requests to.
line=3.x
ref=upstream/main; base="origin/$line"; dir=""; pr=1; cont=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; ref="$2"; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; dir="$2"; shift ;;
    --base) [ $# -ge 2 ] || die "--base needs a value"; base="$2"; shift ;;
    --no-pr) pr=0 ;;
    --continue) cont=1 ;;
    --run-checks) run_checks ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

here=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$here"
git remote get-url origin >/dev/null 2>&1 || die "this checkout has no remote origin (the fork)"
git remote get-url upstream >/dev/null 2>&1 || { say "adding the remote upstream: $UPSTREAM_URL"; git remote add upstream "$UPSTREAM_URL"; }
slug() { git remote get-url "$1" | sed -E 's#^(git@|ssh://git@|https://)([^/:]+)[:/]##; s#\.git$##; s#/$##'; }
fork=$(slug origin); up=$(slug upstream)
[ "$fork" != "$up" ] || die "origin and upstream are the same repo ($fork): this script only ever pushes to the fork"

state_file() { printf '%s/sync-upstream' "$(git -C "$1" rev-parse --absolute-git-dir)"; }
version_at() { git show "$1:package.json" | sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' | head -n 1; }
unmerged() { git diff --name-only --diff-filter=U; }

# Merge the upstream commit $ref into HEAD; on conflicts, list them and stop with 3 (renix's agent, or a person,
# resolves them in the worktree, stages them, and the script goes on with --continue).
merge_upstream() {
  if git merge --no-ff --no-edit -m "Merge upstream $new ($n commits) into the fork's $line" "$ref" >/dev/null 2>&1; then
    return 0
  fi
  unmerged > "$st.conflicts"
  [ -s "$st.conflicts" ] || die "git merge $ref failed in $dir, with no conflicted files: see git status there"
  say "conflicts in:"; sed 's/^/  /' "$st.conflicts" >&2
  say "resolve them in $dir (keep upstream's change and put the fork's back on top: FORK.md, \"Conflicts\"), stage them,"
  say "then run: nix develop --command sh scripts/sync-upstream.sh --continue --dir $dir"
  exit 3
}

if [ "$cont" = 0 ]; then
  say "fetching origin and upstream"
  git fetch --quiet origin
  git fetch --quiet upstream
  git rev-parse --verify --quiet "$ref^{commit}" >/dev/null || die "no such upstream ref: $ref"
  git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "no such fork ref: $base"
  if git merge-base --is-ancestor "$ref" "$base"; then say "$base already has $ref ($(git rev-parse --short "$ref")): nothing to do"; exit 0; fi
  new=$(version_at "$ref"); old=$(version_at "$base")
  branch="sync/upstream-$new"
  if [ "$new" = "$old" ] || git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null || git rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
    branch="sync/upstream-$new-$(date +%Y-%m-%d)"
  fi
  git rev-parse --verify --quiet "refs/heads/$branch" >/dev/null && die "the branch $branch is there already: finish it (--continue --dir …) or delete it"
  [ -n "$dir" ] || dir="${TMPDIR:-/tmp}/shepherdr-$(printf '%s' "$branch" | tr '/' '-')"
  [ ! -e "$dir" ] || die "$dir is there already: finish it (--continue --dir $dir), or remove it"
  git worktree add --quiet -b "$branch" "$dir" "$base"
  n=$(git rev-list --count --no-merges "$base..$ref")
  ref=$(git rev-parse "$ref")
  say "merging upstream $new ($(git rev-parse --short "$ref"), $n commits) into $branch in $dir"
  dir=$(CDPATH= cd -- "$dir" && pwd)
  cd "$dir"
  st=$(state_file .)
  { echo "ref=$ref"; echo "base=$(git rev-parse "$base")"; echo "new=$new"; echo "old=$old"; echo "n=$n"; } > "$st"
  : > "$st.conflicts"
  merge_upstream
else
  [ -n "$dir" ] || die "--continue needs the worktree's --dir"
  [ -d "$dir" ] || die "$dir is not there: nothing to continue"
  dir=$(CDPATH= cd -- "$dir" && pwd)
  cd "$dir"
  st=$(state_file .)
  [ -f "$st" ] || die "$dir has no sync in progress"
  # The saved upstream commit, not --ref: upstream may have moved on since the merge began.
  . "$st"
  [ -z "$(unmerged)" ] || die "$dir still has conflicts: $(unmerged | tr '\n' ' ')" 3
  if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
    [ "$(git rev-parse MERGE_HEAD)" = "$ref" ] || die "$dir is merging $(git rev-parse --short MERGE_HEAD), not the saved upstream commit $(git rev-parse --short "$ref")"
    git add -A
    if git diff --cached --check 2>/dev/null | grep -q 'conflict marker'; then
      git diff --cached --check 2>/dev/null | grep 'conflict marker' >&2 || true
      die "conflict markers are left in $dir: resolve them, then --continue" 3
    fi
    git commit --quiet --no-edit
    say "committed the merge of upstream $new"
  elif ! git merge-base --is-ancestor "$ref" HEAD; then
    # No merge under way and upstream's commit not merged (an aborted merge): merge it again.
    say "upstream $new is not merged in $dir: merging it again"
    merge_upstream
  fi
fi
branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in sync/upstream-*) ;; *) die "$dir is on $branch, not a sync/upstream-* branch" ;; esac
git merge-base --is-ancestor "$ref" HEAD || die "$branch does not have upstream's $ref merged"

# The fork's checks, at the lowest priority: what CI's Check workflow builds on (dependencies, generated plugin list,
# types, the shared copies), the Python tests (the repo's rules, the installer, herdr-task, the layer's own), the
# layer's Bun tests (the test files FORK.md's table names) and the layer itself (scripts/fork_layer.py: every file it
# names is there, every hook keeps its `fork:` comment). Not the whole Bun suite and the build: GitHub's Check workflow
# runs those. SHEPHERDR_SYNC_CHECK, a shell command, replaces all of it (test/test_sync_upstream.py).
log="$st.check.log"
say "running the fork's checks at low priority (log: $log)"
if ! nice -n 19 sh "$script" --run-checks > "$log" 2>&1; then
  tail -n 40 "$log" >&2
  die "the check failed: fix it in $dir, commit, then --continue (log: $log)" 4
fi
[ -z "$(git status --porcelain)" ] || die "the check left changes in $dir: commit them (or ignore them), then --continue" 4
[ -f /etc/NIXOS ] && where="NixOS ($(uname -m))" || where="$(uname -s) $(uname -m)"

body="$st.pr.md"
{
  echo "Merges upstream ($up) \`$(git rev-parse --short "$ref")\` into the fork's $line: **$old → $new**, $n commits."
  echo
  echo "**Merge this pull request with \"Create a merge commit\"**, never squash or rebase: the next sync then sees these"
  echo "commits as merged (FORK.md)."
  echo
  echo "## Upstream's changes"
  echo
  git log --no-merges --format='- %s (`%h`)' "$base..$ref"
  echo
  echo "## Conflicts"
  echo
  if [ -s "$st.conflicts" ]; then
    sed 's/^/- `/; s/$/`/' "$st.conflicts"
    echo
    echo "Resolved as FORK.md, \"Conflicts\" says: see the merge commit's diff against upstream (\`git diff $(git rev-parse --short "$ref") HEAD -- <file>\`)."
  else
    echo "None."
  fi
  echo
  echo "## Checked on $where"
  echo
  echo "- The layer is intact (\`scripts/fork_layer.py check\`), typecheck, \`bin/sync-shared --check\`, the Python tests and"
  echo "  the layer's Bun tests passed."
  echo "- GitHub's Check workflow runs on pull requests to main only; on this line by hand:"
  echo "  \`gh workflow run check.yml --repo $fork --ref $line\`."
  echo
  echo "## The fork's layer after the merge"
  echo
  echo '```'
  git diff --stat "$ref" HEAD | tail -n 1
  echo '```'
} > "$body"

if [ "$pr" = 0 ]; then say "done, nothing pushed (--no-pr). Branch $branch in $dir; the pull request's text: $body"; cat "$body"; exit 0; fi
command -v gh >/dev/null 2>&1 || die "gh is not installed: push $branch and open the pull request by hand (text: $body)"
say "pushing $branch to origin ($fork)"
git push --quiet -u origin "$branch"
if [ -n "$(gh pr list --repo "$fork" --head "$branch" --base "$line" --state open --json number --jq '.[].number')" ]; then
  say "the pull request for $branch is open already: updated by the push"
  exit 0
fi
say "opening the pull request into $line"
gh pr create --repo "$fork" --base "$line" --head "$branch" --title "Sync with upstream $new" --body-file "$body"
