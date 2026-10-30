// Fork (dmasiero/shepherdr): a follow-up pull request on Gitea. A task's pull request was merged already (by hand on
// Gitea, or its answer lost) at an earlier commit, and the branch has work since that the merge did not bring in.
// Upstream refuses the merge as a changed head; here a second pull request opens from the same branch, titled after
// the task with "(follow-up)", and becomes the task's own. With nothing new since, that merge was the task's. Gitea
// only: GitHub keeps upstream's behavior. FORK.md, docs/gitea.md.
import { createHash } from 'node:crypto'
import type { CoreForgeGit } from './forge.ts'
import type { ForgePr } from './gitea.ts'

export const MARK = ' (follow-up)'

interface FollowTask { id: string; name: string; machine: string; repo: string; folder: string; branch: string; base: string; pr?: { number: number; url: string }; pushedHead?: string; said?: string; desc?: string }

export const followUpBody = (merged: { number: number; url: string }, body: string) =>
  `Follow-up to #${merged.number} (${merged.url}).\n\nThat pull request was merged already, and the task's branch has work since that it did not bring in. This pull request brings in that work.\n\n${body}`

/** the branch at `head` has work the merged pull request did not bring in: head is past the merged head, and merging
 *  it into the merge commit would still change something (a conflict counts as work) */
export async function workSince(git: CoreForgeGit, task: FollowTask, pr: ForgePr, head: string) {
  const worktree = { machine: task.machine, folder: task.folder }, repo = { machine: task.machine, folder: task.repo }
  if (pr.headRefOid && await git.contains(worktree, pr.headRefOid, head).catch(() => false)) return false
  const merged = pr.mergeCommit?.oid
  if (!merged) throw Error('Gitea has not confirmed the merge commit of the merged pull request yet; retry')
  // The merge commit is on the remote base; fetch it beside the task's refs, never into the base checkout.
  const ref = `refs/shepherdr/follow-up/${createHash('sha256').update(JSON.stringify([task.machine, task.repo, task.base])).digest('hex')}`
  await git.run(repo, ['fetch', '--no-tags', 'origin', `refs/heads/${task.base}:${ref}`], 90)
  let tree: string
  try { tree = (await git.run(repo, ['merge-tree', '--write-tree', merged, head])).split('\n')[0] } catch { return true }
  return tree !== await git.run(repo, ['rev-parse', `${merged}^{tree}`])
}

/** a merged Gitea pull request at an earlier commit than `head`: opened (its follow-up, the branch pushed first), or
 *  landed (nothing since: that merge was the task's). Undefined when this is not that case. */
export async function mergedEarlier(git: CoreForgeGit, task: FollowTask, pr: ForgePr, head: string, remote: string) {
  const worktree = { machine: task.machine, folder: task.folder }
  if (pr.state !== 'MERGED' || pr.headRefOid === head || pr.baseRefName !== task.base || !await git.gitea(worktree)) return undefined
  if (!await workSince(git, task, pr, head)) return { landed: true as const }
  // The remote branch may still be where the merged pull request left it (pushed by hand), or gone (Gitea deleted it
  // after the merge): either is known, so the push lease takes it. Anything else is someone else's, and refused.
  const ref = `refs/heads/${task.branch}`, listed = (await git.run(worktree, ['ls-remote', '--heads', 'origin', ref], 60)).split('\n').find(line => line.endsWith(`\t${ref}`))?.split('\t')[0] ?? ''
  const pushed = await git.pushTaskBranch(worktree, task.branch, [pr.headRefOid, ''].includes(listed) ? listed || undefined : task.pushedHead)
  await git.createPr(worktree, remote, { base: task.base, branch: task.branch, title: `${task.id}: ${task.name}${MARK}`, body: followUpBody(pr, task.said || task.desc || task.name) })
  const opened = await git.pullRequest(worktree, task.branch, false)
  if (opened.state !== 'OPEN' || opened.number === pr.number) throw Error(`PR #${pr.number} was merged already and ${task.branch} has work since, but Gitea did not show its follow-up pull request`)
  return { opened: { number: opened.number, url: opened.url }, pushed, said: `PR #${pr.number} was merged already at an earlier commit, and ${task.branch} has work since that it did not bring in: opened follow-up PR #${opened.number} (${opened.url}) with it. Report ready again, then merge.` }
}

/** a new task pull request's title and body: a follow-up's when the task's last one on Gitea was merged */
export async function newPrText(git: CoreForgeGit, task: FollowTask) {
  const title = `${task.id}: ${task.name}`, body = task.said || task.desc || task.name
  const gitea = task.pr && await git.gitea({ machine: task.machine, folder: task.folder })
  if (!gitea || !task.pr) return { title, body }
  const last = await gitea.raw(task.pr.number)
  return last.merged ? { title: title + MARK, body: followUpBody(task.pr, body) } : { title, body }
}
