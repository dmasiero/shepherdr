# This fork (2.1 line)

This repo is a fork of [eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) ("upstream"). This branch,
`2.1`, is the fork's line on upstream 2.1, the standalone app beside herdr-core (no longer a herdr plugin), taken at
upstream's tag v2.1.0. It follows upstream's main and adds a small layer upstream doesn't carry.

It is not a GitHub fork: upstream was herdr-projects, renamed, and that network's fork is
[dmasiero/herdr-projects](https://github.com/dmasiero/herdr-projects). This repo holds upstream's history as it is,
with the layer on top.

## Branches

| Branch | What |
| --- | --- |
| `main` | The 2.0 line (upstream 2.0 plus the 2.0 layer, its own FORK.md) until the cutover. renix pins and builds it, and syncs it from upstream's `v2.0`. |
| `v2.0` | Where `main` stood when the 2.1 line began (`0f4eff9`): the 2.0 line to roll back to after the cutover. |
| `2.1` | This line. It becomes `main` at the cutover. |

`2.1` is a branch beside `main`, not `main` itself yet, because the running Shepherdr is 2.0, built from `main`: renix
pins `main` (renix's `pkgs/forks.nix`, `pkgs/shepherdr.nix`) and its daily sync merges upstream's `v2.0` into it. Neither
can follow 2.1 before renix packages it as a standalone app.

### The cutover

`main` becomes `2.1` without rewriting its history or force-pushing. The 2.1 line descends from upstream's `v2.0`, as
`main` does, so a merge of `main` into `2.1` that keeps `2.1`'s files records the 2.0 line as replaced, and `main` then
moves forward to it:

```sh
git fetch origin
git switch 2.1 && git merge --ff-only origin/2.1
git merge -s ours --no-edit -m "Replace the 2.0 line with the 2.1 line" origin/main   # 2.1's files, main's history
git push origin 2.1
git push origin 2.1:main                                                              # a fast-forward, no force
```

Then set `line=main` in `scripts/sync-upstream.sh`, point renix at `main` and upstream's `main`, and keep `v2.0` for
rollback. Until then, renix syncs `main` (2.0) only, never this line.

## The layer

Everything is upstream's except these. `git diff upstream/main 2.1` shows it all once a sync has brought in upstream's
newest commits (`git diff v2.1.0 2.1` before the first one).

| File | What |
| --- | --- |
| `FORK.md` | This page. |
| `scripts/sync-upstream.sh`, `flake.nix`, `flake.lock` | The sync with upstream that renix runs, and its dev shell (Bun, Node, gh, git, tea). |
| `server/core/forge.ts` | Which forge a repo is on (GitHub or Gitea, `shepherdr.forge`), and each pull request call sent to gh or tea. `CoreForgeGit` is upstream's `CoreGit` with these on top. |
| `server/core/gitea.ts` | Gitea's pull requests, checks, merge, comments and panel view, in the shapes of upstream's GitHub calls. |
| `server/core/tea.ts` | tea's logins and one call of Gitea's API through `tea api -i`, with its HTTP status. |
| `server/core/follow-up.ts` | A Gitea pull request merged already at an earlier commit: the follow-up pull request. |
| `docs/gitea.md` | What Gitea support does and needs. |
| `test/core-gitea.test.ts`, `test/fake-tea.ts` | Its tests, with tea faked as a Gitea kept in a JSON file and a bare repo. |
| `server/core/operator-tasks.ts` | Task commands for scripts: `task add`, `list`, `show` and `tell` on the private operator socket. |
| `helper/operator-tasks.ts` | Their client side: a brief or message moved to stdin. |
| `test/core-operator-tasks.test.ts` | Their tests. |

Planned, each its own change that adds its row here, its `fork:` comments in upstream's files and its tests to the
sync's check list:

- **Voice calls start without a first_message override**: ElevenLabs closes a call whose agent doesn't allow that
  override (2.0 had the same fix).
- **Git over SSH on NixOS**: 2.1's checked Git (`helper/core-pilot-ssh.ts`) refuses an SSH configuration file with
  more than one hard link, and NixOS's `/etc/ssh/ssh_config` is a store file that the store hard-links. Until that is
  fixed, `test/core-pilot-git.test.ts` fails here and stays out of the sync's check list.

Upstream's files change only where the layer hooks in, each marked with a `fork:` comment.

**Gitea pull requests through `tea`** ([docs/gitea.md](docs/gitea.md)): 2.1 opens, checks and merges pull requests
on GitHub only, and the fork's spaces are on Gitea. A space whose origin is on Gitea now gets them there, and GitHub
keeps upstream's calls as they are. Its hooks:

- `server/core/git.ts`: `teaRun`, tea run as `gh` is (its status lines kept, `tea.ts` `teaArgv`).
- `server/core/tasks.ts`: `CoreForgeGit` for `CoreGit`; `prNow`, `readyNow` and `merge` call `createPr`, `editPr`,
  `readyPr` and `mergePr` instead of their `gh pr` commands; `merge` and `prNow` open a Gitea follow-up
  (`follow-up.ts`); the brief's Settings block, its "Merged on GitHub" lines and the refusals of `ready`, `merge`
  and `pr` are said in the forge's words.
- `server/core/agents.ts`, `server/core/source.ts`: the skills given to every agent are said in the space's forge's
  words (`forgeWords`).
- `server/core/github-pr.ts`: a Gitea pull request's comments come from `gitea.ts`; its card and notice name Gitea.
- `server/core/github.ts`: a Gitea space's base is not watched for going red (GitHub's Actions only).
- `server/core/worktree.ts`: the task panel's pull request comes from `gitea.ts` for a Gitea task.
- `helper/core-pilot-git.ts`: the contained repository runner runs `tea` too.

**Task commands for scripts**: on 2.0, Doug's dispatchers (Chatwoot, Graylog, spam review, through dotfiles'
`shepherdr_board.py`) add tasks and message them with `shepherdr task add/list/tell` from outside any agent. 2.1's
command refuses those outside an agent session. The fork lets trusted scripts on the main machine run them through
the operator socket upstream already has for `secret set/rm`: a Unix socket in the private home (`~/.shepherdr`,
mode 0700), itself 0600 and owned by you, so only your own user on this machine reaches it. Nothing listens on the
network and no web route or agent mailbox gains these commands.

```sh
shepherdr task add "<title>" --space ops [--after OPS-1] [--later] [--set merge="ask me first"] --brief "<brief>"   # or < brief.md
shepherdr task list [--json] [--archived] [--space ops]       # --json: [{id, title, status, state, space, archived?}]
shepherdr task show OPS-12 [--json]                           # with its pull request, when it has one
shepherdr task tell OPS-12 "<message>"                        # or < message.txt
```

They speak 2.0's words where the dispatchers read them: `task add` answers `Added OPS-12: <title>. ...`, `--json`
rows carry `id`, `title`, `status` (`done` once merged or closed) and `archived`, and an unknown task is `No task
OPS-12 ...`. Only the main machine's repository spaces and their tasks; `tell` refuses a Done or archived task (a
message would start it again), so a script adds a new one. A brief or message travels on stdin, past the socket's
limits on command words (16 of 256 characters), at most 64 KiB; the command moves 2.0's `--brief TEXT` and `tell ID
TEXT` there itself. A task command may take up to 100 s (adding one makes its worktree and starts its agent). Every
other task command stays an agent's. Its hooks:

- `bin/shepherdr`: `task add|list|show|tell` go to `helper/core-operator.ts`, as `secret set|rm` do.
- `helper/core-operator.ts`: `taskStdin` (`helper/operator-tasks.ts`) before the request.
- `server/core/operator.ts`: a task command goes to `operator-tasks.ts`, with its longer deadline.

## Syncing with upstream

`scripts/sync-upstream.sh`, run in the dev shell, merges upstream's main into a `sync/upstream-<version>` branch made
from this line, in a worktree of its own, runs the fork's checks (`bun run typecheck`, the tests of what the layer
touches, `bun run build`, the tests at the lowest priority: the one exception to AGENTS.md's no-tests rule, as renix runs it at
night before a merge no one reviews) and opens the sync pull request to `2.1`. A conflict (exit 3) or a failed check
(exit 4) is fixed in that worktree, then the script goes on with `--continue`. By hand:

```sh
nix develop --command sh scripts/sync-upstream.sh            # or --no-pr to push and open nothing
# after resolving conflicts or fixing the check in the worktree it names:
nix develop --command sh scripts/sync-upstream.sh --continue --dir <worktree>
```

Upstream comes in by merge, never by rebase or squash: the line is published, and a merge keeps upstream's commits as
they are, so the next sync only sees what is new. A sync pull request is merged with **Create a merge commit**.

GitHub's Check workflow (`.github/workflows/check.yml`, every test with the browser ones) runs on pushes to `main`
only. Before the cutover, run it on this line by hand: `gh workflow run check.yml --repo dmasiero/shepherdr --ref 2.1`.

### Conflicts

A conflict is almost always in one of the layer's hook lines: keep upstream's change and put the hook back (the
`fork:` comment with it). While resolving, check with `nix develop --command bun run typecheck` only (AGENTS.md): the
script runs the tests when it goes on.
