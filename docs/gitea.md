# Gitea pull requests (fork)

The fork's Gitea layer ([FORK.md](../FORK.md)): a task in a repo whose remote is a Gitea server goes through a pull
request there, as a GitHub repo's task does through GitHub. Upstream knows only GitHub, so without this a Gitea repo's
tasks merged into the local base branch and nothing was pushed.

It runs through [tea](https://gitea.com/gitea/tea), Gitea's command line, where `gh` runs for GitHub: herdr-task
(`mods/tasks/bin/herdr_task/gitea.py`) and the Pull request views (`core/worktree.js` `giteaPr`, read by the web app's
service and the window's `mods/task-pr`) ask Gitea's API with `tea api --login <login>`.

## Setting it up

On each machine whose tasks work in the repo:

```sh
tea login add --name masiero --url https://gitea.masiero.internal --token <token>   # once
tea login list    # its URL's host, or its SSH host, must be the remote's host
```

Nothing else: a repo is on Gitea when its push remote's host is one a tea login serves (its address or its SSH host,
e.g. `ssh://git@gitea.masiero.internal:2222/masiero/infra.git`). To say it outright, in the repo:

```sh
git config shepherdr.forge gitea    # or github; unset (auto) decides by the remote's host
```

`gitea` with no tea login for the host is said, never guessed past: ready leaves the task Ready with "tea isn't logged
in to <host>", and Accept refuses to merge it locally. A GitHub host is GitHub as upstream reads it, and tea is never
asked; any other host goes to upstream's `gh repo view` (no pull requests, tasks merge locally, when gh doesn't know it).
The answer is kept for an hour per repo (as upstream keeps GitHub's).

## What happens

- **Ready** pushes the task's branch (as on GitHub) and opens a pull request into its base, titled with the task's ref
  and title, its prompt, summary and details as the body. A pull request already open for the branch (opened by hand or
  by the agent, from this repo, at the branch's tip) is adopted; ready again comments its new summary there. A
  `WIP:` title is taken off, since Gitea won't merge it. A branch that already had one merged is refused, as on GitHub.
- **Checks**: the commit statuses on its head (Gitea Actions' or any CI's) are its checks, `warning` passing. A status
  the base's branch protection requires that hasn't shown yet counts as running (only a repo admin's token can read
  the protection). The task shows Working while they run and goes back to its agent when one fails or it conflicts,
  then Ready, as a GitHub task does. Gitea reports a new head as unmergeable while it checks it: asked once more,
  1.5 s later, before that counts as a conflict.
- **News**: failed checks, reviews, review comments and comments since ready reach the resting agent as "Gitea news on
  pull request #n", with links to Gitea. There is no log tail (gh reads only GitHub's).
- **Accept** (and the auto and checks merge settings) merges it on Gitea in the repo's default merge style (a merge
  commit unless the repo says otherwise), only at the head it read, and deletes its branch there. Then, as for GitHub,
  the base branch here catches up (fetch, fast-forward when it's checked out and clean), and the worktree and branch go.
- A Gitea repo's task is never merged locally: with no pull request (ready couldn't open one) Accept and
  `herdr-task merge` refuse and say why; fix that (often a tea login) and have its agent run ready again.
- The Pull request view (web and window) reads it through tea, with "Open on Gitea".

## Not done (yet)

- Required reviews and an out-of-date branch aren't read before the merge: Gitea's merge refuses, and the task says
  "Gitea didn't merge it: …" with Gitea's words. It goes again on the next Accept.
- The base branch isn't watched after a merge (GitHub's `main_pass` reads Actions runs through gh).
- The worker template still says "GitHub news"; the news itself says Gitea.
