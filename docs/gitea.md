# Gitea

Fork only (FORK.md). A space whose remote is on a Gitea server gets its pull requests there, through `tea`, Gitea's
command line, as a space on GitHub gets them through `gh`. Everything Shepherdr does with a pull request works the
same: `shepherdr pr` pushes the branch and opens a draft, `shepherdr ready` readies it with the summary,
`shepherdr checks` waits for its checks, `shepherdr merge` squash-merges it at the commit this machine has and deletes
its branch, news on it (a failed check, a review, a comment) wakes its agent, and main going red after a merge is told
to the space's coordinator. The task's `pr` (`{number, url}`, as `shepherdr task show --json` prints it) is the Gitea
pull request, its link ending in `/pulls/<n>`. What Shepherdr says about it names Gitea and tea, not GitHub and gh.

## What it needs

- `tea` on the PATH, 0.14 or newer (`tea api`).
- A tea login for the server: `tea login add --url https://gitea.example.org`; `tea login list` shows them. Shepherdr
  uses the login whose address or SSH host is the host of the space's remote `origin`, so the remote may be HTTPS or
  SSH, on any port (`ssh://git@gitea.example.org:2222/owner/repo.git`, `git@gitea.example.org:owner/repo.git`).
- Pushing goes through `git` itself, with the remote and keys you set up for it.

## Which forge a space is on

The repo's git config `shepherdr.forge` decides, `auto` when unset:

- `auto`: origin's host. A GitHub host is GitHub, as upstream reads it (tea is never asked). A host a tea login
  serves is Gitea. Any other host has no pull requests: tasks merge here, as upstream does with no GitHub remote.
- `gitea`: the repo is on Gitea, whatever its host. Without tea or a login for it, nothing merges: `shepherdr merge`
  says why (`tea is not logged in to gitea.example.org …`), as with gh logged in but GitHub not answering.
- `github`: as upstream, whatever the host.

Set it in the repo: `git config shepherdr.forge gitea`. A login Gitea refuses (HTTP 401), or a server not answering,
never falls back to merging here.

## How it differs from GitHub

- **A draft** is Gitea's work-in-progress title: the pull request opens as `WIP: <title>`, and the mark comes off when
  the task is ready, or before it merges.
- **Checks** are the commit statuses on the pull request's head: Gitea Actions' and any other CI's. `warning` passes.
  A status the base branch's protection requires (by name; a pattern with `*` names none) and that has not shown yet
  counts as running. A failed one's link goes to its job, and its log's last lines (before the runner's clean-up) go
  with the news to the agent, read through Gitea's Actions API.
- **Workflows** that run on pull requests are looked for in `.gitea/workflows` too, so a branch just pushed waits for
  its first status to show rather than taking none as passed.
- **Reviews**: Gitea's `REQUEST_CHANGES` and `COMMENT` read as GitHub's, and each review's line comments are read
  with it.
- **A conflict** Gitea refuses only with "try again later": Shepherdr reads the pull request's mergeable flag and says
  it conflicts, so merging again rebases it, as on GitHub. A merge at a head that moved is refused (`head out of date`).
- Gitea has no merge queue and its auto-merge is never set: Shepherdr merges by itself.
