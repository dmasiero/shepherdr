// Fork (dmasiero/shepherdr): which forge holds a repo's pull requests, GitHub (through gh, as upstream's git.ts) or
// Gitea (through tea, gitea.ts), and each pull request call sent to the right one. CoreForgeGit is upstream's CoreGit
// with these calls on top; tasks use it where upstream uses CoreGit, and a GitHub repo runs upstream's own gh calls.
//
// The repo's git config shepherdr.forge says which (auto when unset): auto reads origin's host. A GitHub one (as
// git.ts's githubRemote knows them) is GitHub; a host one of tea's logins serves (its address or its SSH host), or one
// named gitea, is Gitea; any other has no pull requests (the task merges here, as upstream). gitea and github say it
// outright, whatever the host. FORK.md, docs/gitea.md.
import { CoreGit, githubRemote, type RepoLocation } from './git.ts'
import { CoreGitea, type ForgePr, type GiteaTarget } from './gitea.ts'
import { TEA_MISSING, noLogin, parseAnswer, parseLogins, serves, teaFailure, type TeaLogin } from './tea.ts'

export type ForgeKind = 'github' | 'gitea'

/** host and owner/name of a remote URL (ssh://git@host:2222/o/r.git, git@host:o/r, https://host/o/r); none for a folder */
export function remoteOf(url: string): { host: string; repo: string } | undefined {
  const text = url.trim()
  if (!text || text.startsWith('/') || text.startsWith('.') || /^file:/i.test(text)) return undefined
  const match = text.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
  return match ? { host: match[1].toLowerCase(), repo: match[2] } : undefined
}

/** what Shepherdr says of GitHub, in Gitea's words: Gitea and tea, not GitHub and gh */
export function giteaWords(text: string) {
  return text
    .replace(/gh auth status/g, 'tea login list')
    .replace(/gh auth login/g, 'tea login add')
    .replace(/\bgh (isn't|can't|is not)\b/g, 'tea $1')
    .replace(/GitHub(?! Copilot)/g, 'Gitea')
}

const KEEP = 60_000
const key = (repo: RepoLocation) => JSON.stringify([repo.machine, repo.folder])

export class CoreForgeGit extends CoreGit {
  private logins = new Map<string, { at: number; value: Promise<TeaLogin[]> }>()
  private targets = new Map<string, { at: number; value: Promise<GiteaTarget | undefined> }>()
  /** each repo's forge as last read, for words said where nothing is awaited */
  private kinds = new Map<string, ForgeKind | undefined>()

  /** tea's logins on the repo's machine, asked again after a minute; a failure is never kept */
  private teaLogins(repo: RepoLocation) {
    const kept = this.logins.get(repo.machine)
    if (kept && Date.now() - kept.at < KEEP) return kept.value
    const value = this.teaRun(repo, ['login', 'list', '--output', 'json'], 20).then(parseLogins, error => { throw Error(teaFailure(error)) })
    this.logins.set(repo.machine, { at: Date.now(), value })
    value.catch(() => { if (this.logins.get(repo.machine)?.value === value) this.logins.delete(repo.machine) })
    return value
  }
  /** the repo's Gitea, or none for a GitHub repo or one without pull requests. Read again after a minute. */
  giteaTarget(repo: RepoLocation): Promise<GiteaTarget | undefined> {
    const id = key(repo), kept = this.targets.get(id)
    if (kept && Date.now() - kept.at < KEEP) return kept.value
    const value = this.readTarget(repo)
    this.targets.set(id, { at: Date.now(), value })
    value.then(target => this.kinds.set(id, target ? 'gitea' : undefined), () => {})
    value.catch(() => { if (this.targets.get(id)?.value === value) this.targets.delete(id) })
    return value
  }
  private async readTarget(repo: RepoLocation): Promise<GiteaTarget | undefined> {
    const said = (await this.run(repo, ['config', '--get', 'shepherdr.forge']).catch(() => '')).trim().toLowerCase()
    if (said === 'github' || !(await this.run(repo, ['remote'])).split('\n').includes('origin')) return undefined
    const [used, written] = await Promise.all([this.run(repo, ['remote', 'get-url', 'origin']), this.run(repo, ['config', '--get', 'remote.origin.url'])])
    if (said !== 'gitea' && (githubRemote(used) ?? githubRemote(written))) return undefined
    const remotes = [remoteOf(used), remoteOf(written)].filter(remote => !!remote)
    if (!remotes.length) { if (said === 'gitea') throw Error('shepherdr.forge is gitea, but origin is no Gitea address'); return undefined }
    const named = said === 'gitea' || remotes.some(remote => /gitea/i.test(remote.host))
    let logins: TeaLogin[]
    try { logins = await this.teaLogins(repo) } catch (error) {
      // No tea, and nothing says Gitea: a repo without pull requests, as upstream has with no GitHub origin.
      if (!named && (error as Error).message === TEA_MISSING) return undefined
      throw error
    }
    for (const remote of remotes) {
      const login = logins.find(login => serves(login, remote.host))
      if (login) return { host: remote.host, repo: remote.repo, login: login.name, url: login.url }
    }
    if (named) throw Error(noLogin(remotes[0].host))
    return undefined
  }
  /** the repo's Gitea pull requests, or none for a repo not on Gitea */
  async gitea(repo: RepoLocation): Promise<CoreGitea | undefined> {
    const target = await this.giteaTarget(repo)
    if (!target) return undefined
    return new CoreGitea(target, async (method, path, body, timeout = 60) => {
      const args = ['api', '--login', target.login, '-i', '-X', method, ...(body === undefined ? [] : ['-d', '@-']), path]
      let out: string
      try { out = await this.teaRun(repo, args, timeout, body === undefined ? undefined : JSON.stringify(body)) } catch (error) { throw Error(teaFailure(error)) }
      return parseAnswer(out)
    })
  }
  /** the forge a repo was last read on (words said where nothing is awaited); undefined when unread or not Gitea */
  known(repo: RepoLocation) { return this.kinds.get(key(repo)) }
  /** a text in the words of the repo's forge, as last read */
  said(repo: RepoLocation, text: string) { return this.known(repo) === 'gitea' ? giteaWords(text) : text }
  /** an error in the words of the repo's forge, as last read: the same error, its message said again */
  saidError(repo: RepoLocation, error: Error) {
    if (this.known(repo) === 'gitea') error.message = giteaWords(error.message)
    return error
  }
  /** the words of the repo's forge, read now; a forge that can't be read keeps upstream's words */
  async words(repo: RepoLocation): Promise<(text: string) => string> {
    try { return await this.gitea(repo) ? giteaWords : text => text } catch { return text => text }
  }

  override async remote(repo: RepoLocation) {
    const target = await this.giteaTarget(repo)
    return target ? `${target.host}/${target.repo}` : super.remote(repo)
  }
  override async findPullRequest(repo: RepoLocation, branch: string, base: string): Promise<ForgePr | undefined> {
    const gitea = await this.gitea(repo)
    if (!gitea) return super.findPullRequest(repo, branch, base)
    return gitea.find(branch, base)
  }
  override async pullRequest(repo: RepoLocation, branch: string, checks = true): Promise<ForgePr> {
    const gitea = await this.gitea(repo)
    return gitea ? gitea.view(branch, checks) : super.pullRequest(repo, branch, checks)
  }
  /** open the task's draft pull request; on GitHub, upstream's own gh pr create */
  async createPr(repo: RepoLocation, remote: string, o: { base: string; branch: string; title: string; body: string }) {
    const gitea = await this.gitea(repo)
    if (gitea) { await gitea.create({ ...o, draft: true }); return }
    await this.ghRun(repo, ['pr', 'create', '--repo', remote, '--draft', '--base', o.base, '--head', o.branch, '--title', o.title, '--body-file', '-'], 60, o.body)
  }
  async editPr(repo: RepoLocation, remote: string, number: number, body: string) {
    const gitea = await this.gitea(repo)
    if (gitea) return gitea.edit(number, body)
    await this.ghRun(repo, ['pr', 'edit', String(number), '--repo', remote, '--body-file', '-'], 60, body)
  }
  async readyPr(repo: RepoLocation, remote: string, number: number) {
    const gitea = await this.gitea(repo)
    if (gitea) return gitea.ready(number)
    await this.ghRun(repo, ['pr', 'ready', String(number), '--repo', remote])
  }
  /** squash-merge at exactly `head`; the branch is kept */
  async mergePr(repo: RepoLocation, remote: string, number: number, head: string) {
    const gitea = await this.gitea(repo)
    if (gitea) {
      // Gitea refuses a work-in-progress title; Ready took it off, unless someone put it back.
      await gitea.ready(number)
      return gitea.merge(number, head)
    }
    await this.ghRun(repo, ['pr', 'merge', String(number), '--squash', '--match-head-commit', head, '--repo', remote], 90)
  }
}
