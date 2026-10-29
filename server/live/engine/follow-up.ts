// Fork (dmasiero/shepherdr): a follow-up pull request. A task's pull request was merged already (by hand on GitHub or
// Gitea, or its answer lost), and its branch has work since that the merge did not bring in: the agent went on after
// it, or left work uncommitted that shepherdr merge committed. Upstream marks the task merged and that work stays
// out of main; here a second pull request opens from the same branch, titled after the task with "(follow-up)", and
// becomes the task's own. The same on GitHub and on Gitea. FORK.md, docs/follow-up.md.
import * as G from './forge.ts'

export const MARK = ' (follow-up)'

/**
 * The branch has work its merged pull request did not bring in: it is no ancestor of the commit the pull request was
 * merged at, and merging it into `base` (origin/main) would still change something.
 */
export async function workSince(wt: string, pr: G.Pr, base: string, id: string) {
  if (pr.headRefOid && (await G.git(wt, 'merge-base', '--is-ancestor', 'HEAD', pr.headRefOid)).ok) return false
  return !(await G.landed(wt, 'HEAD', base, await G.squashesOf(wt, base, id)))
}

export const followUpBody = (merged: { number: number; url: string }, body: string) =>
  `Follow-up to #${merged.number} (${merged.url}).\n\nThat pull request was merged already, and the task's branch has work since that it did not bring in. This pull request brings in that work.\n\n${body}`

/**
 * Opens the follow-up of a merged pull request when the branch has work since: pushed first, then opened (a draft
 * when asked) from the branch into the task's base. Null: nothing new, the merge was the task's.
 */
export async function followUp(
  g: G.GitHub,
  t: { id: string; title: string; branch: string; base: string; worktree: string },
  merged: G.Pr,
  o: { body: string; draft: boolean; push: () => Promise<G.Run> },
): Promise<null | { error: string } | { number: number; url: string }> {
  if (!(await workSince(t.worktree, merged, `origin/${t.base}`, t.id))) return null
  const push = await o.push()
  if (!push.ok) return { error: `PR #${merged.number} was merged already, and ${t.branch} has work since; could not push it to GitHub: ${(push.err || push.out).split('\n')[0]}` }
  const r = await G.openPr(g, t.worktree, { branch: t.branch, base: t.base, title: `${t.title}${MARK}`, body: followUpBody(merged, o.body), draft: o.draft })
  if ('error' in r) return { error: `PR #${merged.number} was merged already, and ${t.branch} has work since it did not bring in, but GitHub did not open its follow-up pull request: ${r.error}` }
  return r
}
