#!/bin/sh
# The fork's sync with upstream (FORK.md, "Syncing with upstream"): merges upstream's main into a
# `sync/upstream-<version>` branch made from the fork's 2.1 line (`line` below), in a worktree of its own, runs the
# fork's checks and opens a pull request to that line. renix runs it in the dev shell (`nix develop`, flake.nix) and
# merges the pull request; by hand:
#   sh scripts/sync-upstream.sh              fetch, merge, check, push the branch, open the pull request
#   sh scripts/sync-upstream.sh --no-pr      the same, but push and open nothing
#   sh scripts/sync-upstream.sh --continue   after resolving conflicts (or fixing the check) in the worktree it named
# Options: --ref <upstream ref> (default upstream/main), --base <fork ref> (default origin/<line>), --dir <worktree folder>.
# Exit: 0 done or nothing new, 1 an error, 3 conflicts to resolve, 4 the check failed. Never pushes to upstream.
set -e
say() { printf 'sync-upstream: %s\n' "$*" >&2; }
die() { say "$1"; exit "${2:-1}"; }
UPSTREAM_URL="https://github.com/eliasstravik/shepherdr.git"
# The fork's branch this script syncs and opens pull requests to: 2.1 until it becomes main at the cutover (FORK.md).
line=2.1
ref=upstream/main; base="origin/$line"; dir=""; pr=1; cont=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) ref="$2"; shift ;;
    --dir) dir="$2"; shift ;;
    --base) base="$2"; shift ;;
    --no-pr) pr=0 ;;
    --continue) cont=1 ;;
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

if [ "$cont" = 0 ]; then
  say "fetching origin and upstream"
  git fetch --quiet origin
  git fetch --quiet --tags upstream
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
  [ ! -e "$dir" ] || die "$dir is there already: remove it, or name another with --dir"
  git worktree add --quiet -b "$branch" "$dir" "$base"
  n=$(git rev-list --count --no-merges "$base..$ref")
  say "merging $ref ($new, $n commits) into $branch in $dir"
  cd "$dir"
  st=$(state_file .)
  { echo "ref=$(git rev-parse "$ref")"; echo "base=$(git rev-parse "$base")"; echo "new=$new"; echo "old=$old"; echo "n=$n"; } > "$st"
  if ! git merge --no-ff --no-edit -m "Merge upstream $new ($n commits) into the fork's $line" "$ref" >/dev/null 2>&1; then
    git diff --name-only --diff-filter=U > "$st.conflicts"
    say "conflicts in:"; sed 's/^/  /' "$st.conflicts" >&2
    say "resolve them in $dir (keep upstream's code and put the fork's change back on top: FORK.md, 'Conflicts'),"
    say "then run: sh scripts/sync-upstream.sh --continue --dir $dir"
    exit 3
  fi
  : > "$st.conflicts"
else
  [ -n "$dir" ] || die "--continue needs the worktree's --dir"
  cd "$dir"
  st=$(state_file .)
  [ -f "$st" ] || die "$dir has no sync in progress"
  [ -z "$(git diff --name-only --diff-filter=U)" ] || die "$dir still has conflicts: $(git diff --name-only --diff-filter=U | tr '\n' ' ')" 3
  if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then git add -A && git commit --quiet --no-edit; fi
fi
branch=$(git rev-parse --abbrev-ref HEAD)
. "$st"
case "$branch" in sync/upstream-*) ;; *) die "$dir is on $branch, not a sync/upstream-* branch" ;; esac
git merge-base --is-ancestor "$ref" HEAD || die "$branch does not have upstream's $ref merged (was the merge aborted?): merge it again, then --continue"

# The fork's checks (FORK.md): the types, the tests of what the fork's layer touches and the build, at the lowest
# priority. Not the whole suite with its browser tests: GitHub's Check workflow runs that. The one exception to
# AGENTS.md's no-tests rule (FORK.md). Each fork change adds its own tests here. Not test/core-pilot-git.test.ts yet:
# its SSH test fails on NixOS, whose /etc/ssh/ssh_config is a hard-linked store file that the check refuses (FORK.md).
tests="test/core-voice.test.ts test/core-gitea.test.ts test/core-tasks.test.ts test/core-github.test.ts test/core-git.test.ts test/core-github-pr.test.ts test/core-github-merges.test.ts test/core-worktree.test.ts test/core-operator.test.ts test/core-operator-tasks.test.ts"
say "running the fork's checks (bun install, bun run typecheck, bun test <the layer's tests>, bun run build)"
log="$st.check.log"
check() {
  bun install --frozen-lockfile --no-progress &&
    bun run typecheck &&
    # shellcheck disable=SC2086
    nice -n 19 bun test $tests &&
    bun run build
}
if ! (check) > "$log" 2>&1; then tail -n 40 "$log" >&2; die "the check failed: fix it in $dir, commit, then --continue (log: $log)" 4; fi
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
  if [ -s "$st.conflicts" ]; then sed 's/^/- `/; s/$/`/' "$st.conflicts"; echo; echo "Resolved by hand: see the merge commit's diff against upstream (\`git diff $ref HEAD -- <file>\`)."; else echo "None."; fi
  echo
  echo "## Checked on $where"
  echo
  echo "- \`bun run typecheck\`, \`bun test $tests\` and \`bun run build\` passed."
  echo "- GitHub's Check workflow (every test, the browser ones too) runs on main after the merge; on another line by hand:"
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
say "pushing $branch to origin ($fork) and opening the pull request"
git push --quiet -u origin "$branch"
gh pr create --repo "$fork" --base "$line" --head "$branch" --title "Sync with upstream $new" --body-file "$body"
