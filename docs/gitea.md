# Gitea

Fork only ([FORK.md](../FORK.md)). A space whose remote is on a Gitea server gets its pull requests there, through
`tea`, Gitea's command line, as a space on GitHub gets them through `gh`. Everything a task does with a pull request
works the same: `shepherdr pr` pushes the branch and opens a draft, `shepherdr ready` writes the summary into it and
readies it, `shepherdr checks` shows its checks, `shepherdr merge` merges it with a merge commit at the commit this
machine has (the branch is kept; on GitHub, upstream squash-merges), news on it (a failed check, a review, a comment) wakes its agent, a pull request merged
on Gitea by hand is seen and the task marked merged, and the task panel shows it with its checks. The task's `pr`
(`{number, url}`) is the Gitea pull request, its link ending in `/pulls/<n>`. What Shepherdr tells the agents and the
coordinator about it (the skills, a brief's Settings block, refusals, news) names Gitea, not GitHub.

## What it needs

- `tea` on the PATH of the machine the space is on, 0.14 or newer (`tea api`).
- A tea login for the server: `tea login add --url https://gitea.example.org`; `tea login list` shows them. Shepherdr
  uses the login whose address or SSH host is the host of the space's remote `origin`, so the remote may be HTTPS or
  SSH, on any port (`ssh://git@gitea.example.org:2222/owner/repo.git`, `git@gitea.example.org:owner/repo.git`).
- Pushing goes through `git` itself, with the remote and keys you set up for it.

## Which forge a space is on

The repo's git config `shepherdr.forge` decides, `auto` when unset:

- `auto`: origin's host. A GitHub host is GitHub, as upstream reads it (tea is never asked). A host a tea login
  serves, or one named `gitea`, is Gitea. Any other host has no pull requests: tasks merge here, as upstream does with
  no GitHub remote.
- `gitea`: the repo is on Gitea, whatever its host.
- `github`: as upstream, whatever the host.

On Gitea, without tea or a login for the host, nothing merges: `shepherdr merge` says why (`tea is not logged in to
gitea.example.org …`). A login Gitea refuses (HTTP 401), or a server not answering, never falls back to merging here.

## How it differs from GitHub

- **A draft** is Gitea's work-in-progress title: the pull request opens as `WIP: <title>`, and the mark comes off when
  the task is ready (and again before it merges, if someone put it back).
- **Checks** are the commit statuses on the pull request's head: Gitea Actions' and any other CI's. `warning` passes.
  A commit with no status has no checks, as on GitHub. A status the base branch's protection requires (by name; a
  pattern with `*` names none) that has not shown yet counts as pending, so the merge waits for it.
- **Reviews**: Gitea's `REQUEST_CHANGES` and `COMMENT` read as GitHub's, and each review's line comments with it.
- **A conflict** Gitea only answers with "try again later": Shepherdr reads the pull request's mergeable flag and says
  it conflicts, so the agent rebases. A merge at a head that moved is refused.
- **Merged already.** A pull request merged on Gitea at an earlier commit than the branch has now: with work since
  (the agent went on after the merge), `shepherdr pr` or `shepherdr merge` opens a follow-up pull request from the
  same branch, titled after the task with `(follow-up)` and linking the first, and it becomes the task's pull
  request; the merge stops there, to be readied and merged as any other. With nothing new since, that merge was the
  task's. On GitHub, upstream's behavior stays.
- **Main going red** is watched on GitHub only for now: a Gitea space's base branch is not.
- **A merged pull request's head** is read from its `refs/pull/<n>/head`, where Gitea left it at the merge: Gitea's
  answer for a single pull request names its branch's tip, which may have moved on since.
- **After a merge, the branch** may still be where the merge left it, or gone if Gitea deletes merged branches: either
  way the next push of the task's branch (for its follow-up) goes ahead. Any other remote update is refused, as on
  GitHub.
- Gitea has no merge queue and its auto-merge is never set: Shepherdr merges by itself.
