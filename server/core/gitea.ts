// Fork (dmasiero/shepherdr): a repo's pull requests on Gitea, through tea's API calls (tea.ts), each answering in the
// shapes 2.1's GitHub calls do (git.ts, github-pr.ts), so tasks do with a Gitea repo what they do with a GitHub one
// (forge.ts picks which). A draft is Gitea's "WIP:" title; checks are the commit statuses on the pull request's head
// (Gitea Actions report as those), with any its base's branch protection requires and that have not shown yet counted
// as pending; a merge is a merge commit. A closed pull request's head is its refs/pull/<n>/head: Gitea's answer for one
// pull request names its branch's tip, which may have moved on since. FORK.md, docs/gitea.md.
import type { PrCheck, PullRequest } from '../../shared/types.ts'
import type { GitHubComment } from './github-pr.ts'
import { okAnswer, said, type Answer } from './tea.ts'

/** a repo on a Gitea server: its host and owner/name there, and the tea login (and its address) that reaches it */
export interface GiteaTarget { host: string; repo: string; login: string; url: string }

/** one call of Gitea's API as the target's login: `path` without /api/v1/ */
export type GiteaApi = (method: string, path: string, body?: unknown, timeout?: number) => Promise<Answer>

/** the pull request as 2.1 reads GitHub's (git.ts pullRequest) */
export interface ForgeCheck { name?: string; context?: string; state?: string; conclusion?: string; status?: string; targetUrl?: string; detailsUrl?: string }
export interface ForgePr { number: number; url: string; state: string; isDraft?: boolean; headRefOid: string; baseRefName: string; mergeCommit?: { oid: string } | null; statusCheckRollup: ForgeCheck[] }

interface RawPr { number: number; html_url: string; state: string; merged?: boolean; draft?: boolean; title: string; mergeable?: boolean; merge_commit_sha?: string | null; updated_at?: string; head?: { ref?: string; label?: string; sha?: string }; base?: { ref?: string } }

const PAGE = 50
const SHA = /^[a-f0-9]{40,64}$/

export const isWip = (title: string) => /^\s*(wip:|\[wip\])/i.test(title)
export const withoutWip = (title: string) => title.replace(/^\s*(wip:|\[wip\])\s*/i, '')

/** a Gitea commit status in GitHub's words (its state field): warning passes, as it blocks nothing there either */
const STATE: Record<string, string> = { success: 'SUCCESS', warning: 'NEUTRAL', failure: 'FAILURE', error: 'ERROR', pending: 'PENDING', skipped: 'SKIPPED' }

export class CoreGitea {
  constructor(private readonly target: GiteaTarget, private readonly api: GiteaApi) {}
  private get root() { return `repos/${this.target.repo}` }
  private async get<T>(path: string): Promise<T> {
    const answer = await this.api('GET', path)
    if (!okAnswer(answer)) throw Error(said(answer))
    return answer.body as T
  }
  private async send(method: string, path: string, body: unknown) {
    const answer = await this.api(method, path, body, 120)
    if (!okAnswer(answer)) throw Error(said(answer))
    return answer
  }
  /** a list, page by page, at most `pages` of them; more than that is unread, never taken as all, unless `newest`
   *  says the first pages (newest first) are all that is wanted */
  private async list<T>(path: string, pages = 5, newest = false): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= pages; page++) {
      const rows = await this.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&page=${page}`)
      if (!Array.isArray(rows)) throw Error('Gitea did not return a list')
      out.push(...rows)
      if (rows.length < PAGE) return out
    }
    if (newest) return out
    throw Error('Too many Gitea results for one bounded read')
  }
  /** a link Gitea gave without its server (/owner/repo/actions/runs/1/jobs/0), whole */
  private whole(link?: string) {
    if (!link) return undefined
    return /^https?:\/\//.test(link) ? link : `${(this.target.url || `https://${this.target.host}`).replace(/\/+$/, '')}${link.startsWith('/') ? '' : '/'}${link}`
  }
  private shape(pr: RawPr, checks: ForgeCheck[] = []): ForgePr {
    if (!pr || !Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.html_url !== 'string' || typeof pr.title !== 'string') throw Error('Gitea returned an invalid pull request')
    const merge = pr.merged && pr.merge_commit_sha && SHA.test(pr.merge_commit_sha) ? { oid: pr.merge_commit_sha } : null
    return { number: pr.number, url: pr.html_url, state: pr.merged ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: !!pr.draft || isWip(pr.title),
      headRefOid: pr.head?.sha ?? '', baseRefName: pr.base?.ref ?? '', mergeCommit: merge, statusCheckRollup: checks }
  }
  /** its branch: Gitea calls a merged one's whose branch is gone refs/pull/<n>/head, and keeps the name as its label */
  private branchOf(pr: RawPr) { return pr.head?.ref && !pr.head.ref.startsWith('refs/pull/') ? pr.head.ref : pr.head?.label ?? '' }
  /** the branch's pull requests: its open ones, else its closed ones among the 200 updated last, the newest first */
  private async prsOf(branch: string): Promise<RawPr[]> {
    const open = (await this.list<RawPr>(`${this.root}/pulls?state=open`)).filter(pr => this.branchOf(pr) === branch)
    if (open.length) return open
    return (await this.list<RawPr>(`${this.root}/pulls?state=closed&sort=recentupdate`, 4, true)).filter(pr => this.branchOf(pr) === branch)
  }
  /** where a closed pull request's head stood when it closed: refs/pull/<n>/head, which Gitea moves only while open */
  private async closedHead(pr: RawPr): Promise<RawPr> {
    if (pr.state === 'open') return pr
    const refs = await this.get<{ ref?: string; object?: { sha?: string } }[] | { ref?: string; object?: { sha?: string } }>(`${this.root}/git/refs/pull/${pr.number}/head`)
    const sha = (Array.isArray(refs) ? refs : [refs]).find(ref => ref?.ref === `refs/pull/${pr.number}/head`)?.object?.sha
    if (!sha || !SHA.test(sha)) throw Error(`Gitea did not return the head of closed PR #${pr.number}`)
    return { ...pr, head: { ...pr.head, sha } }
  }
  /** an open pull request from `branch` into `base`, as git.ts findPullRequest: none, or exactly one */
  async find(branch: string, base: string) {
    const found = (await this.list<RawPr>(`${this.root}/pulls?state=open`)).filter(pr => this.branchOf(pr) === branch && pr.base?.ref === base)
    if (found.length > 1) throw Error('Gitea did not return an unambiguous task pull request')
    return found[0] ? this.shape(found[0]) : undefined
  }
  /** the branch's pull request, as `gh pr view <branch>`: its open one, else its newest closed one; with checks */
  async view(branch: string, checks = true): Promise<ForgePr> {
    const prs = await this.prsOf(branch)
    if (prs.filter(pr => pr.state === 'open').length > 1) throw Error('Gitea did not return an unambiguous task pull request')
    if (!prs[0]) throw Error(`no pull requests found for branch "${branch}"`)
    const pr = await this.closedHead(prs[0])
    return this.shape(pr, checks && pr.state === 'open' && pr.head?.sha ? await this.checks(pr.head.sha, pr.base?.ref ?? '') : [])
  }
  async raw(number: number) { return this.get<RawPr>(`${this.root}/pulls/${number}`) }
  /** one pull request by number, its head where it closed for a closed one */
  async pull(number: number) { return this.shape(await this.closedHead(await this.raw(number))) }
  /** open a pull request from the pushed branch; a draft is its title with WIP: in front */
  async create(o: { branch: string; base: string; title: string; body: string; draft: boolean }) {
    const title = o.draft && !isWip(o.title) ? `WIP: ${o.title}` : o.title
    const answer = await this.send('POST', `${this.root}/pulls`, { head: o.branch, base: o.base, title, body: o.body })
    return this.shape(answer.body as RawPr)
  }
  async edit(number: number, body: string) { await this.send('PATCH', `${this.root}/pulls/${number}`, { body }) }
  /** ready for review: the WIP: mark comes off its title */
  async ready(number: number) {
    const pr = await this.raw(number)
    if (isWip(pr.title)) await this.send('PATCH', `${this.root}/pulls/${number}`, { title: withoutWip(pr.title) })
  }
  /** merge with a merge commit while the head is still `head` (as gh pr merge --match-head-commit); the branch is
   *  kept. For a conflict Gitea only says to try later: its mergeable flag says it conflicts. */
  async merge(number: number, head: string) {
    const answer = await this.api('POST', `${this.root}/pulls/${number}/merge`, { Do: 'merge', head_commit_id: head, delete_branch_after_merge: false }, 120)
    if (okAnswer(answer)) return
    if (answer.code === 405) {
      const pr = await this.raw(number).catch(() => undefined)
      if (pr && !pr.merged && pr.mergeable === false) throw Error(`Conflict with the base branch: Gitea cannot merge PR #${number} (${said(answer)}); rebase in the task worktree and report ready again`)
    }
    throw Error(said(answer))
  }
  /** the status checks the base's branch protection requires, by name (a pattern with * names none to wait for) */
  private async required(base: string) {
    let rules: { rule_name?: string; branch_name?: string; enable_status_check?: boolean; status_check_contexts?: string[] }[]
    try { rules = await this.get(`${this.root}/branch_protections`) } catch { return [] } // Only repo admins may read them.
    if (!Array.isArray(rules)) return []
    const covers = (rule: string) => !rule.includes('*') ? rule === base
      : new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`).test(base)
    return [...new Set(rules.filter(rule => rule.enable_status_check && covers(rule.rule_name || rule.branch_name || '')).flatMap(rule => rule.status_check_contexts ?? []).filter(name => name && !name.includes('*')))]
  }
  /** the latest status of each context on a commit, every page of them, plus required ones not shown yet as pending.
   *  Gitea's combined state is of each page's own statuses; a commit with none says "pending" with no statuses,
   *  which is no check at all, as GitHub's empty rollup. */
  async checks(sha: string, base: string): Promise<ForgeCheck[]> {
    if (!SHA.test(sha)) throw Error('Gitea returned an invalid pull request head')
    const out: ForgeCheck[] = [], combined = new Set<string>()
    for (let page = 1; ; page++) {
      if (page > 20) throw Error('Too many Gitea commit statuses for one bounded read')
      const result = await this.get<{ state?: string; statuses?: { context?: string; status?: string; state?: string; target_url?: string }[] | null }>(`${this.root}/commits/${sha}/status?limit=${PAGE}&page=${page}`)
      const rows = result?.statuses ?? []
      if (rows.length) combined.add(STATE[(result.state ?? '').toLowerCase()] ?? 'PENDING')
      out.push(...rows.map(row => ({ name: row.context || 'Check', context: row.context, state: STATE[(row.status ?? row.state ?? '').toLowerCase()] ?? 'PENDING', targetUrl: this.whole(row.target_url) })))
      if (rows.length < PAGE) break
    }
    const bad = (check: ForgeCheck) => ['FAILURE', 'ERROR'].includes(check.state ?? '')
    if ((combined.has('FAILURE') || combined.has('ERROR')) && !out.some(bad)) out.push({ name: 'combined status', state: 'FAILURE' })
    if (combined.has('PENDING') && !out.some(check => bad(check) || check.state === 'PENDING')) out.push({ name: 'combined status', state: 'PENDING' })
    for (const name of await this.required(base)) if (!out.some(check => check.context === name)) out.push({ name, context: name, state: 'PENDING' })
    return out
  }
  /** everything written on a pull request, in github-pr.ts's shape: reviews (r), their line comments (c), comments (i) */
  async comments(number: number): Promise<GitHubComment[]> {
    type Raw = { id: number; user?: { login?: string }; body?: string | null; html_url?: string; created_at?: string; submitted_at?: string; state?: string; path?: string; line?: number; position?: number; original_position?: number; comments_count?: number }
    const [reviews, notes] = await Promise.all([this.list<Raw>(`${this.root}/pulls/${number}/reviews`), this.list<Raw>(`${this.root}/issues/${number}/comments`)])
    const sent = reviews.filter(review => review.state !== 'PENDING' && review.state !== 'REQUEST_REVIEW')
    const page = `${(this.target.url || `https://${this.target.host}`).replace(/\/+$/, '')}/${this.target.repo}/pulls/${number}`
    const of = (row: Raw, kind: string, at = row.submitted_at || row.created_at): GitHubComment => {
      if (!row || !Number.isSafeInteger(row.id)) throw Error('Invalid Gitea comment response')
      const when = Date.parse(at || '')
      if (!Number.isFinite(when)) throw Error('Gitea comment has no confirmed publication time')
      return { id: `${kind}${row.id}`, at: when, who: typeof row.user?.login === 'string' ? row.user.login.slice(0, 128) : 'someone', body: (row.body || '').trim(), url: (row.html_url || page).slice(0, 2000) }
    }
    const out: GitHubComment[] = sent.map(review => ({ ...of(review, 'r'), ...(review.state ? { state: ({ REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' } as Record<string, string>)[review.state] ?? review.state } : {}) }))
    for (const review of sent.filter(review => (review.comments_count ?? 0) > 0)) {
      for (const line of await this.get<Raw[]>(`${this.root}/pulls/${number}/reviews/${review.id}/comments`)) {
        const at = line.line || line.position || line.original_position
        out.push({ ...of(line, 'c', review.submitted_at || line.created_at), ...(line.path ? { where: `${line.path.slice(0, 512)}${at ? `:${at}` : ''}` } : {}) })
      }
    }
    out.push(...notes.map(note => of(note, 'i')))
    if (out.length > 10000) throw Error('Too many Gitea comments for one bounded snapshot')
    return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
  }
  /** the task panel's pull request (PullRequest): the branch's open one, else its last, with its checks */
  async panel(branch: string): Promise<{ pr: PullRequest | null; why?: string }> {
    const prs = await this.prsOf(branch)
    const pr = prs[0]
    if (!pr) return { pr: null, why: 'No pull request yet.' }
    const shaped = this.shape(pr)
    let checks: ForgeCheck[] = [], checksError: string | undefined
    if (shaped.state === 'OPEN' && SHA.test(shaped.headRefOid)) checks = await this.checks(shaped.headRefOid, shaped.baseRefName).catch(() => { checksError = 'Could not read Gitea checks.'; return [] })
    const STATES: Record<string, PrCheck['state']> = { SUCCESS: 'pass', NEUTRAL: 'pass', FAILURE: 'fail', ERROR: 'fail', SKIPPED: 'skip', PENDING: 'pending' }
    return { pr: { number: shaped.number, title: withoutWip(pr.title), state: shaped.state === 'MERGED' ? 'merged' : shaped.state === 'CLOSED' ? 'closed' : shaped.isDraft ? 'draft' : 'open', url: shaped.url,
      checks: checks.map(check => ({ name: check.name || 'Check', state: STATES[check.state ?? ''] ?? 'pending', url: check.targetUrl })), ...(checksError ? { checksError } : {}) } }
  }
}
