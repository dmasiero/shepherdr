# A pull request merged already

Fork only (FORK.md). Sometimes `shepherdr merge` finds a task's pull request merged already: someone merged it by hand
on GitHub or Gitea while the agent went on, or left work uncommitted that the merge then committed. Upstream marks the
task merged, and the work after that merge never reaches main (it stays on the branch, which is kept). Here:

- **Nothing new on the branch** (its head is the commit the pull request merged at, or merging it into main would
  change nothing): the task is merged with that merge, as upstream.
- **Work since:** the branch is pushed and a **follow-up pull request** opens from it into the same base, titled after
  the task with `(follow-up)`; its description links the first one and says why. It becomes the task's pull request
  (`pr` in `shepherdr task show --json`). The merge stops there and says so: the follow-up goes in as any other, when
  its agent merges again (asked by someone else, the agent is told). `shepherdr pr` on a merged pull request with work
  since opens the follow-up the same way, a draft until the task is ready.

It works the same on GitHub (gh) and Gitea (tea, [gitea.md](gitea.md)).
