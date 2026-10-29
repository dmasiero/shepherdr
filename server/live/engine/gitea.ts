// Fork (dmasiero/shepherdr): a repo's pull requests on Gitea, through tea's API calls (tea.ts), each the twin of a gh
// one in git.ts and answering in its shapes, so the engine does with a Gitea repo what it does with a GitHub one
// (forge.ts picks which). A draft is Gitea's "WIP:" title; checks are the commit statuses on the pull request's head
// (Gitea Actions report as those), with any its branch protection requires and that have not shown yet counted as
// running; Actions' runs and job logs are read through Gitea's Actions API. FORK.md, docs/gitea.md.
import type { BranchRun, Check, Pr, PrChecks, PrComment, Run } from './git.ts'
import { api, okAnswer, said, type Answer } from './tea.ts'

/** a repo on a Gitea server: its host and owner/name there, the tea login that reaches it ('' for none) and that
 *  login's address (its links are made from it) */
export interface Gitea {
  host: string
  repo: string
  login: string
  url?: string
}

type GiteaPr = { number: number; html_url: string; state: string; merged?: boolean; draft?: boolean; title: string; body?: string; mergeable?: boolean; merge_commit_sha?: string | null; head?: { ref?: string; label?: string; sha?: string }; base?: { ref?: string } }

const PAGE = 50

/** a GET as the repo's login: its body, or why not */
async function get<T>(g: Gitea, cwd: string, path: string): Promise<T | { error: string }> {
  const a = await api(g.login, cwd, 'GET', path)
  return 'error' in a || !okAnswer(a) ? { error: said(a) } : (a.body as T)
}

const failed = (x: unknown): x is { error: string } => !!x && typeof x === 'object' && 'error' in x && !Array.isArray(x)

/** a list, page by page, at most `pages` of them; null when Gitea did not answer */
async function list<T>(g: Gitea, cwd: string, path: string, pages = 5): Promise<T[] | null> {
  const out: T[] = []
  for (let page = 1; page <= pages; page++) {
    const r = await get<T[]>(g, cwd, `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&page=${page}`)
    if (failed(r) || !Array.isArray(r)) return null
    out.push(...r)
    if (r.length < PAGE) break
  }
  return out
}

/** a call that changes something, as a gh run would have answered */
async function send(g: Gitea, cwd: string, method: string, path: string, body: unknown): Promise<Run & { answer?: Answer }> {
  const a = await api(g.login, cwd, method, path, body, 120_000)
  if (!('error' in a) && okAnswer(a)) return { ok: true, code: 0, out: a.text, err: '', answer: a }
  return { ok: false, code: 1, out: '', err: said(a), ...('error' in a ? {} : { answer: a }) }
}

/** logged in to the repo's server ("yes"), no login for it ("no"), or one that is refused or not answering ("down") */
export async function giteaLogin(g: Gitea, cwd: string): Promise<{ state: 'yes' | 'no' | 'down'; said?: string }> {
  if (!g.login) return { state: 'no' }
  const a = await api(g.login, cwd, 'GET', 'user', undefined, 30_000)
  if (!('error' in a) && okAnswer(a)) return { state: 'yes' }
  return { state: 'down', said: said(a) }
}

/** Gitea's draft: a title that starts with a work-in-progress mark */
export const isWip = (title: string) => /^\s*(wip:|\[wip\])/i.test(title)
export const withoutWip = (title: string) => title.replace(/^\s*(wip:|\[wip\])\s*/i, '')

/** its branch: Gitea calls a merged one's whose branch is gone refs/pull/<n>/head, and keeps the name as its label */
const branchOf = (p: GiteaPr) => (p.head?.ref && !p.head.ref.startsWith('refs/pull/') ? p.head.ref : (p.head?.label ?? ''))

const asPr = (p: GiteaPr): Pr => ({ number: p.number, url: p.html_url, state: p.merged ? 'MERGED' : p.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: !!p.draft || isWip(p.title), headRefOid: p.head?.sha ?? '', baseRefName: p.base?.ref ?? '' })

/** the branch's pull requests, the open ones first, then the closed ones newest first */
async function prsOf(g: Gitea, cwd: string, branch: string): Promise<GiteaPr[] | null> {
  const open = await list<GiteaPr>(g, cwd, `repos/${g.repo}/pulls?state=open`)
  if (!open) return null
  const mine = open.filter((p) => branchOf(p) === branch)
  if (mine.length) return mine
  const closed = await list<GiteaPr>(g, cwd, `repos/${g.repo}/pulls?state=closed&sort=recentupdate`, 2)
  return closed ? closed.filter((p) => branchOf(p) === branch) : null
}

/** the branch's pull request: its open one, else one merged already */
export async function findPr(g: Gitea, cwd: string, branch: string): Promise<Pr | null> {
  const prs = await prsOf(g, cwd, branch)
  const p = prs?.find((x) => x.state === 'open') ?? prs?.find((x) => x.merged)
  return p ? asPr(p) : null
}

export async function viewPr(g: Gitea, cwd: string, n: number): Promise<Pr | null> {
  const p = await get<GiteaPr>(g, cwd, `repos/${g.repo}/pulls/${n}`)
  return failed(p) ? null : asPr(p)
}

/** open a pull request from the branch (pushed already); a draft is its title with WIP: in front */
export async function openPr(g: Gitea, cwd: string, o: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<{ number: number; url: string } | { error: string }> {
  const title = o.draft && !isWip(o.title) ? `WIP: ${o.title}` : o.title
  const r = await send(g, cwd, 'POST', `repos/${g.repo}/pulls`, { head: o.branch, base: o.base, title, body: o.body })
  const p = r.answer?.body as GiteaPr | undefined
  return r.ok && p?.number ? { number: p.number, url: p.html_url } : { error: r.err || 'Gitea did not say why' }
}

export const editPr = (g: Gitea, cwd: string, n: number, body: string) => send(g, cwd, 'PATCH', `repos/${g.repo}/pulls/${n}`, { body })

export async function closePr(g: Gitea, cwd: string, n: number, comment: string): Promise<Run> {
  await send(g, cwd, 'POST', `repos/${g.repo}/issues/${n}/comments`, { body: comment })
  return send(g, cwd, 'PATCH', `repos/${g.repo}/pulls/${n}`, { state: 'closed' })
}

/** ready for review: the WIP: mark comes off its title */
export async function readyPr(g: Gitea, cwd: string, n: number): Promise<Run> {
  const p = await get<GiteaPr>(g, cwd, `repos/${g.repo}/pulls/${n}`)
  if (failed(p)) return { ok: false, code: 1, out: '', err: p.error }
  return isWip(p.title) ? send(g, cwd, 'PATCH', `repos/${g.repo}/pulls/${n}`, { title: withoutWip(p.title) }) : { ok: true, code: 0, out: '', err: '' }
}

/** Gitea squash-merges the pull request only while its head is still `sha`; its branch is left for the engine to
 *  delete. Refused for a conflict, Gitea only says to try later: that is said as not mergeable. */
export async function mergePr(g: Gitea, cwd: string, n: number, sha: string, subject: string, body: string): Promise<Run> {
  const r = await send(g, cwd, 'POST', `repos/${g.repo}/pulls/${n}/merge`, { Do: 'squash', MergeTitleField: subject, MergeMessageField: body, head_commit_id: sha })
  if (r.ok || r.answer?.code !== 405) return r
  const p = await get<GiteaPr>(g, cwd, `repos/${g.repo}/pulls/${n}`)
  return !failed(p) && p.mergeable === false && !p.merged ? { ...r, err: `PR #${n} is not mergeable: it conflicts with ${p.base?.ref ?? 'its base'} (${r.err})` } : r
}

/** a link Gitea gave without its server (/owner/repo/actions/runs/1/jobs/2), whole */
const whole = (g: Gitea, link?: string) => (!link ? undefined : /^https?:\/\//.test(link) ? link : `${(g.url || `https://${g.host}`).replace(/\/+$/, '')}${link.startsWith('/') ? '' : '/'}${link}`)

/** a commit status's state as gh pr checks buckets it: Gitea's warning passes (it blocks nothing there either) */
const BUCKET: Record<string, string> = { success: 'pass', warning: 'pass', failure: 'fail', error: 'fail', pending: 'pending', skipped: 'skipping' }

type Status = { context: string; status?: string; state?: string; target_url?: string }

/** does a branch protection rule's name (a glob, as Gitea reads it) take in this branch? */
function covers(rule: string, branch: string) {
  if (!rule.includes('*')) return rule === branch
  const re = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')
  return new RegExp(`^${re}$`).test(branch)
}

/** the status checks the branch protection of `base` requires, by name (a pattern with * names none to wait for) */
async function required(g: Gitea, cwd: string, base: string): Promise<string[]> {
  const rules = await get<{ rule_name?: string; branch_name?: string; enable_status_check?: boolean; status_check_contexts?: string[] }[]>(g, cwd, `repos/${g.repo}/branch_protections`)
  if (failed(rules) || !Array.isArray(rules)) return []
  const out = rules.filter((r) => r.enable_status_check && covers(r.rule_name || r.branch_name || '', base)).flatMap((r) => r.status_check_contexts ?? [])
  return [...new Set(out.filter((c) => c && !c.includes('*')))]
}

/** the most pages of a commit's statuses read (50 each): past that, the checks are unread, never passed */
export const STATUS_PAGES = { max: 100 }

/** the latest status of each context on a commit, as gh pr checks has them, every page of them; null when Gitea did
 *  not answer, or there were more pages than are read. Gitea's combined state is of each page's own statuses: every
 *  page's stands, so a failure (or one still pending) no status read shows is never taken as passed. */
export async function statusesAt(g: Gitea, cwd: string, sha: string): Promise<Check[] | null> {
  const out: Check[] = []
  const combined = new Set<string>()
  for (let page = 1; ; page++) {
    if (page > STATUS_PAGES.max) return null
    const r = await get<{ state?: string; statuses?: Status[] | null }>(g, cwd, `repos/${g.repo}/commits/${sha}/status?limit=${PAGE}&page=${page}`)
    if (failed(r)) return null
    const list = r.statuses ?? []
    if (list.length) combined.add(BUCKET[(r.state ?? '').toLowerCase()] ?? '')
    out.push(...list.map((s) => ({ name: s.context, bucket: BUCKET[(s.status ?? s.state ?? '').toLowerCase()] ?? 'pending', link: whole(g, s.target_url) })))
    // Gitea's total_count is this page's count, not all of them: a short page is the last
    if (list.length < PAGE) break
  }
  if (combined.has('fail') && !out.some((c) => c.bucket === 'fail')) out.push({ name: 'combined status (failure)', bucket: 'fail' })
  if (combined.has('pending') && !out.some((c) => c.bucket === 'fail' || c.bucket === 'pending')) out.push({ name: 'combined status (pending)', bucket: 'pending' })
  return out
}

/** the pull request's checks: its head's commit statuses, and those its base requires that have not shown yet as
 *  running. "none" only when Gitea answered with none; anything unread is "error". */
export async function prChecks(g: Gitea, cwd: string, n: number): Promise<PrChecks> {
  const p = await get<GiteaPr>(g, cwd, `repos/${g.repo}/pulls/${n}`)
  if (failed(p)) return { state: 'error', passed: 0, failed: [], error: p.error }
  const list = await statusesAt(g, cwd, p.head?.sha ?? '')
  if (!list) return { state: 'error', passed: 0, failed: [], error: "Gitea did not answer for the commit's statuses" }
  const missing = (await required(g, cwd, p.base?.ref ?? '')).filter((c) => !list.some((s) => s.name === c))
  const all: Check[] = [...list, ...missing.map((name) => ({ name, bucket: 'pending' }))]
  if (!all.length) return { state: 'none', passed: 0, failed: [] }
  const bad = all.filter((c) => c.bucket === 'fail').map((c) => ({ name: c.name, link: c.link }))
  const passed = all.filter((c) => c.bucket === 'pass').length
  return { state: bad.length ? 'fail' : all.some((c) => c.bucket === 'pending') ? 'pending' : 'pass', passed, failed: bad }
}

type ActionRun = { id: number; head_sha: string; status: string; conclusion?: string | null; html_url: string; path?: string; display_title?: string; started_at?: string; run_started_at?: string; updated_at?: string; completed_at?: string }

/** Actions' runs of the repo matching `query`, newest first; null when Gitea did not answer */
async function runs(g: Gitea, cwd: string, query: string, limit: number): Promise<ActionRun[] | null> {
  const r = await get<{ workflow_runs?: ActionRun[] | null }>(g, cwd, `repos/${g.repo}/actions/runs?${query}&limit=${Math.min(limit, PAGE)}`)
  return failed(r) ? null : (r.workflow_runs ?? [])
}

/** how long Gitea Actions' runs on pull requests take (ms): the middle of the last few that passed */
export async function checksTook(g: Gitea, cwd: string): Promise<number | undefined> {
  const r = await runs(g, cwd, 'event=pull_request&status=success', 5)
  const took = (r ?? [])
    .map((x) => Date.parse(x.completed_at || x.updated_at || '') - Date.parse(x.started_at || x.run_started_at || ''))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b)
  return took.length ? took[Math.floor(took.length / 2)] : undefined
}

/** the verdicts of Gitea Actions' runs on pushes to a branch, its newest commit first (as git.ts branchRuns) */
export async function branchRuns(g: Gitea, cwd: string, branch: string, limit = 30): Promise<BranchRun[] | null> {
  const all = await runs(g, cwd, `branch=${encodeURIComponent(branch)}&event=push`, limit)
  if (!all) return null
  const out: BranchRun[] = []
  for (const sha of [...new Set(all.map((x) => x.head_sha))]) {
    const of = all.filter((x) => x.head_sha === sha && x.conclusion !== 'cancelled')
    if (!of.length) continue
    const bad = of.filter((x) => x.status === 'completed' && !['success', 'neutral', 'skipped'].includes(x.conclusion ?? '')).map((x) => ({ name: (x.path ?? x.display_title ?? 'workflow').replace(/@.*$/, ''), link: x.html_url }))
    out.push({ sha, failed: bad, state: bad.length ? 'fail' : of.some((x) => x.status !== 'completed') ? 'pending' : 'pass' })
  }
  return out
}

type Raw = { id: number; user?: { login?: string }; body?: string; html_url?: string; created_at?: string; submitted_at?: string; state?: string; path?: string; line?: number; position?: number; original_position?: number; comments_count?: number; pull_request_review_id?: number }

/** Gitea's review verdicts in GitHub's words */
const REVIEW: Record<string, string> = { REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }

/** everything written on a pull request (reviews, their line comments, comments), oldest first; null when unread */
export async function prComments(g: Gitea, cwd: string, n: number): Promise<PrComment[] | null> {
  const [reviews, notes] = await Promise.all([list<Raw>(g, cwd, `repos/${g.repo}/pulls/${n}/reviews`), list<Raw>(g, cwd, `repos/${g.repo}/issues/${n}/comments`)])
  if (!reviews || !notes) return null
  const sent = reviews.filter((r) => r.state !== 'PENDING' && r.state !== 'REQUEST_REVIEW')
  const lines: Raw[] = []
  for (const r of sent.filter((r) => (r.comments_count ?? 0) > 0)) {
    const c = await get<Raw[]>(g, cwd, `repos/${g.repo}/pulls/${n}/reviews/${r.id}/comments`)
    if (failed(c)) return null
    lines.push(...c.map((x) => ({ ...x, pull_request_review_id: r.id, created_at: r.submitted_at ?? x.created_at })))
  }
  const url = `${(g.url || `https://${g.host}`).replace(/\/+$/, '')}/${g.repo}/pulls/${n}`
  const of = (c: Raw, kind: string): PrComment => ({ id: `${kind}${c.id}`, at: c.submitted_at ?? c.created_at ?? '', who: c.user?.login ?? 'someone', body: (c.body ?? '').trim(), url: c.html_url ?? url })
  return [
    ...sent.map((c) => ({ ...of(c, 'r'), state: REVIEW[c.state ?? ''] ?? c.state })),
    ...lines.map((c) => {
      const line = c.line || c.position || c.original_position
      return { ...of(c, 'c'), where: c.path ? `${c.path}${line ? `:${line}` : ''}` : undefined }
    }),
    ...notes.map((c) => of(c, 'i')),
  ].sort((a, b) => a.at.localeCompare(b.at))
}

/** the last lines a failed check's job logged before Gitea's runner cleaned up, from its link (…/actions/runs/1/jobs/2,
 *  or a run's: its first failed job); nothing when Gitea can't tell */
export async function failedLog(g: Gitea, cwd: string, link: string, lines = 15): Promise<string | undefined> {
  const run = link.match(/\/actions\/runs\/(\d+)/)?.[1]
  let job = link.match(/\/actions\/runs\/\d+\/jobs\/(\d+)/)?.[1]
  if (!job && run) {
    const jobs = await get<{ jobs?: { id: number; conclusion?: string }[] }>(g, cwd, `repos/${g.repo}/actions/runs/${run}/jobs`)
    job = failed(jobs) ? undefined : jobs.jobs?.find((j) => j.conclusion === 'failure')?.id?.toString()
  }
  if (!job) return undefined
  const a = await api(g.login, cwd, 'GET', `repos/${g.repo}/actions/jobs/${job}/logs`)
  if ('error' in a || !okAnswer(a) || !a.text.trim()) return undefined
  const said = a.text
    .split('\n')
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[\d;]*m/g, '').trimEnd())
    .filter((l) => l.trim())
  // the step's own error when it says one, else everything before the runner's clean-up
  const err = said.findLastIndex((l) => /##\[error\]|::error|❌/.test(l))
  const clean = said.findIndex((l) => /^Cleaning up container for job/.test(l))
  const end = err >= 0 ? err + 1 : clean >= 0 ? clean : undefined
  const tail = said.slice(0, end).slice(-lines).join('\n')
  return tail.length > 1500 ? `…${tail.slice(-1500)}` : tail
}

/** the branch's pull request for the task's panel: its open one, else its last; with its checks */
export async function panelPr(g: Gitea, cwd: string, branch: string) {
  const prs = await prsOf(g, cwd, branch)
  if (!prs) return { error: "Couldn't ask Gitea about it." }
  const p = prs.find((x) => x.state === 'open') ?? prs[0]
  if (!p) return null
  const checks = p.state === 'open' && p.head?.sha ? ((await statusesAt(g, cwd, p.head.sha)) ?? []) : []
  return { pr: asPr(p), title: withoutWip(p.title), checks }
}
