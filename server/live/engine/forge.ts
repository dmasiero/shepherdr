// Fork (dmasiero/shepherdr): which forge holds a repo's pull requests, GitHub (through gh, git.ts) or Gitea (through
// tea, gitea.ts), and each forge call sent to the right one. Everything else is git.ts's own, passed on as it is: the
// engine, the spaces and the task panel import this file where upstream imports git.ts, and that is the whole hook.
//
// The repo's git config shepherdr.forge says which (auto by default): auto reads origin's host, a GitHub one (as
// git.ts knows them) is GitHub and a host a tea login serves (tea login list: its address or its SSH host) is Gitea,
// any other none (the task merges here, as upstream); gitea and github say it outright, whatever the host. A Gitea
// repo is a GitHub record with the tea login in it. FORK.md, docs/gitea.md.
import type { PullRequest, PrCheck } from '../../../shared/types.ts'
import * as GH from './git.ts'
import * as GT from './gitea.ts'
import { noLogin, serves, teaLogins } from './tea.ts'

export * from './git.ts'

/** a repo on a forge, as git.ts's GitHub: on Gitea it has the tea login that reaches it ('' with none: why says why) */
export interface GitHub extends GH.GitHub {
  login?: string
  url?: string
  why?: string
}

export const onGitea = (g: GitHub | null | undefined): g is GitHub & GT.Gitea => typeof g?.login === 'string'

/** host and owner/name of any remote URL (ssh://git@host:2222/o/r.git, git@host:o/r, https://host/o/r); none for a
 *  folder on this machine */
export function remoteOf(url: string): { host: string; repo: string } | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
  return m && !url.trim().startsWith('/') && !url.trim().startsWith('.') ? { host: m[1].toLowerCase(), repo: m[2] } : null
}

/** what the repo's git config shepherdr.forge says: auto, gitea or github */
export async function forgeSaid(repo: string): Promise<'auto' | 'gitea' | 'github'> {
  const r = await GH.git(repo, 'config', '--get', 'shepherdr.forge')
  const v = r.out.trim().toLowerCase()
  return v === 'gitea' || v === 'github' ? v : 'auto'
}

/** repos last read as on Gitea: what Shepherdr says of them names Gitea and tea (forgeWords) */
const giteaRepos = new Set<string>()

/** each forge repo origin may be: as git rewrites it first, then as written (git.ts githubs), Gitea's too */
export async function githubs(repo: string): Promise<GitHub[]> {
  const how = await forgeSaid(repo)
  if (how === 'github') {
    giteaRepos.delete(repo)
    return GH.githubs(repo)
  }
  const [written, used] = await Promise.all([GH.git(repo, 'config', '--get', 'remote.origin.url'), GH.git(repo, 'remote', 'get-url', 'origin')])
  const all: GitHub[] = []
  let logins: Awaited<ReturnType<typeof teaLogins>> | undefined
  for (const url of [used.ok ? used.out : '', written.ok ? written.out : ''].filter(Boolean)) {
    const r = remoteOf(url)
    if (!r) continue
    const gh = how === 'auto' ? GH.parseRemote(url) : null
    if (gh) {
      all.push(gh)
      continue
    }
    logins ??= await teaLogins(repo)
    const l = Array.isArray(logins) ? logins.find((x) => serves(x, r.host)) : undefined
    if (l) all.push({ ...r, login: l.name, url: l.url })
    else if (how === 'gitea') all.push({ ...r, login: '', why: Array.isArray(logins) ? noLogin(r.host) : logins.error })
  }
  const out = all.filter((g, i) => all.findIndex((x) => x.host === g.host && x.repo === g.repo) === i)
  if (out.some(onGitea)) giteaRepos.add(repo)
  else giteaRepos.delete(repo)
  return out
}

export async function github(repo: string): Promise<GitHub | null> {
  return (await githubs(repo))[0] ?? null
}

export async function githubRemote(repo: string): Promise<string | null> {
  return (await github(repo))?.repo ?? null
}

/** the name of a repo's forge as Shepherdr says it: Gitea for one last read as on Gitea, else GitHub */
export const forgeName = (repo?: string): 'Gitea' | 'GitHub' => (repo && giteaRepos.has(repo) ? 'Gitea' : 'GitHub')

/** what Shepherdr says of a repo's pull request, in its forge's words: Gitea and tea for a repo on Gitea */
export function forgeWords(text: string, repo?: string): string {
  if (!repo || !giteaRepos.has(repo)) return text
  return text
    .replace(/ \(gh run view --log-failed shows why\)/g, '')
    .replace(/gh auth status/g, 'tea login list')
    .replace(/gh auth login/g, 'tea login add')
    .replace(/\bgh (isn't|can't|is not)\b/g, 'tea $1')
    .replace(/GitHub/g, 'Gitea')
}

/** forge words on a result's text, error and note */
export function forgeResult<T extends { text?: string; error?: string; note?: string }>(r: T, repo?: string): T {
  if (!repo || !giteaRepos.has(repo)) return r
  const out = { ...r }
  for (const k of ['text', 'error', 'note'] as const) if (typeof out[k] === 'string') out[k] = forgeWords(out[k], repo) as T[typeof k]
  return out
}

/* ---------- each forge call, to gh or to tea ---------- */

export const ghLogin = (g: GitHub, cwd: string) => (onGitea(g) ? (g.login ? GT.giteaLogin(g, cwd) : Promise.resolve({ state: 'down' as const, said: g.why })) : GH.ghLogin(g, cwd))
export const findPr = (g: GitHub, cwd: string, branch: string) => (onGitea(g) ? GT.findPr(g, cwd, branch) : GH.findPr(g, cwd, branch))
export const viewPr = (g: GitHub, cwd: string, n: number) => (onGitea(g) ? GT.viewPr(g, cwd, n) : GH.viewPr(g, cwd, n))
export const openPr = (g: GitHub, cwd: string, o: Parameters<typeof GH.openPr>[2]) => (onGitea(g) ? GT.openPr(g, cwd, o) : GH.openPr(g, cwd, o))
export const editPr = (g: GitHub, cwd: string, n: number, body: string): Promise<GH.Run> => (onGitea(g) ? GT.editPr(g, cwd, n, body) : GH.editPr(g, cwd, n, body))
export const closePr = (g: GitHub, cwd: string, n: number, comment: string) => (onGitea(g) ? GT.closePr(g, cwd, n, comment) : GH.closePr(g, cwd, n, comment))
export const readyPr = (g: GitHub, cwd: string, n: number) => (onGitea(g) ? GT.readyPr(g, cwd, n) : GH.readyPr(g, cwd, n))
export const prChecks = (g: GitHub, cwd: string, n: number) => (onGitea(g) ? GT.prChecks(g, cwd, n) : GH.prChecks(g, cwd, n))
export const checksTook = (g: GitHub, cwd: string) => (onGitea(g) ? GT.checksTook(g, cwd) : GH.checksTook(g, cwd))
export const mergePr = (g: GitHub, cwd: string, n: number, sha: string, subject: string, body: string) => (onGitea(g) ? GT.mergePr(g, cwd, n, sha, subject, body) : GH.mergePr(g, cwd, n, sha, subject, body))
export const branchRuns = (g: GitHub, cwd: string, branch: string, limit?: number) => (onGitea(g) ? GT.branchRuns(g, cwd, branch, limit) : GH.branchRuns(g, cwd, branch, limit))
export const prComments = (g: GitHub, cwd: string, n: number) => (onGitea(g) ? GT.prComments(g, cwd, n) : GH.prComments(g, cwd, n))
export const failedLog = (g: GitHub, cwd: string, link: string, lines?: number) => (onGitea(g) ? GT.failedLog(g, cwd, link, lines) : GH.failedLog(g, cwd, link, lines))

/** workflows that run on pull requests at this commit: GitHub's, or Gitea's own (.gitea/workflows, which Gitea
 *  Actions reads besides .github/workflows) */
export async function hasPrWorkflows(wt: string) {
  if (await GH.hasPrWorkflows(wt)) return true
  const r = await GH.git(wt, 'ls-tree', '--name-only', 'HEAD', '.gitea/workflows/')
  for (const f of (r.ok ? r.out : '').split('\n').filter((f) => /\.ya?ml$/.test(f))) {
    const y = await GH.git(wt, 'show', `HEAD:${f}`)
    if (y.ok && /^\s*(?:on:.*\bpull_request|-?\s*pull_request(?:_target)?\b)/m.test(y.out)) return true
  }
  return false
}

/** the task panel's pull request on Gitea, for a worktree whose repo is there; null for any other (gh's, as upstream) */
export async function giteaPullRequest(wt: string, branch: string): Promise<{ pr: PullRequest | null; why?: string } | null> {
  const g = (await githubs(wt)).find(onGitea)
  if (!g) return null
  if (!g.login) return { pr: null, why: g.why }
  const r = await GT.panelPr(g, wt, branch)
  if (!r) return { pr: null, why: 'No pull request yet.' }
  if ('error' in r) return { pr: null, why: r.error }
  const STATE: Record<string, PrCheck['state']> = { pass: 'pass', fail: 'fail', pending: 'pending', skipping: 'skip' }
  const state = r.pr.state === 'MERGED' ? 'merged' : r.pr.state === 'CLOSED' ? 'closed' : r.pr.isDraft ? 'draft' : 'open'
  return { pr: { number: r.pr.number, title: r.title, state, url: r.pr.url, checks: r.checks.map((c) => ({ name: c.name, state: STATE[c.bucket] ?? 'pending', url: c.link })) } }
}
