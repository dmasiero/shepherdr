import { join } from 'node:path'
import type { PilotRepositoryContext } from './pilot-repositories.ts'
import type { CoreFiles } from './files.ts'

export interface RepoLocation { machine: string; folder: string }
/** Same GitHub host forms as legacy, without importing its worker/SSH transport. */
export function githubRemote(url: string) {
  const match = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i)
  return match && /github/i.test(match[1]) ? `${match[1].toLowerCase()}/${match[2]}` : undefined
}
export class CoreGit {
  constructor(private readonly files: CoreFiles,
    private readonly guard?: (repo: RepoLocation, additional?: string[]) => PilotRepositoryContext | undefined,
    private readonly runtime?: (machine: string) => Promise<{ bun: string; root: string }>) {}
  private async execute(repo: RepoLocation, tool: 'git' | 'gh', args: string[], timeout: number, stdin?: string, additional?: string[]) {
    const context = this.guard?.(repo, additional)
    if (!context) return this.files.exec(repo.machine, [tool, ...args], repo.folder, stdin === undefined ? undefined : Buffer.from(stdin), timeout)
    if (!this.runtime) throw Error('Checked repository runtime is unavailable')
    const runtime = await this.runtime(repo.machine)
    return this.files.exec(repo.machine, [runtime.bun, join(runtime.root, 'helper/core-pilot-git.ts')], undefined,
      Buffer.from(JSON.stringify({ ...context, cwd: repo.folder, tool, args, stdin, timeout: timeout * 1000 })), timeout + 10)
  }
  async run(repo: RepoLocation, args: string[], timeout = 30, stdin?: string, additional?: string[]) { return (await this.execute(repo, 'git', args, timeout, stdin, additional)).toString('utf8').trim() }
  async ghRun(repo: RepoLocation, args: string[], timeout = 60, stdin?: string) { return (await this.execute(repo, 'gh', args, timeout, stdin)).toString('utf8').trim() }
  async head(repo: RepoLocation, ref = 'HEAD') { return this.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]) }
  async clean(repo: RepoLocation) { return !(await this.run(repo, ['status', '--porcelain'])).length }
  async remote(repo: RepoLocation) {
    if (!(await this.run(repo, ['remote'])).split('\n').includes('origin')) return undefined
    // Both URLs matter when insteadOf rewrites a public GitHub URL to a local host/SSH alias.
    const [used, written] = await Promise.all([this.run(repo, ['remote', 'get-url', 'origin']), this.run(repo, ['config', '--get', 'remote.origin.url'])])
    return githubRemote(used) ?? githubRemote(written)
  }
  async gh<T>(repo: RepoLocation, args: string[], timeout = 60): Promise<T> {
    const text = await this.ghRun(repo, args, timeout)
    return (text ? JSON.parse(text) : undefined) as T
  }
  async contains(repo: RepoLocation, base: string, head: string) {
    const common = await this.run(repo, ['merge-base', base, head])
    return common === await this.head(repo, head)
  }
  async addWorktree(repo: RepoLocation, folder: string, branch: string, base: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(base) || base.includes('..')) throw new Error('Invalid base branch')
    await this.head(repo, base)
    await this.run(repo, ['worktree', 'add', '-b', branch, folder, base], 60, undefined, [folder])
  }
  async pullRequest(repo: RepoLocation, branch: string) {
    const remote = await this.remote(repo)
    if (!remote) throw Error('This repository has no GitHub origin')
    return this.gh<{ number: number; url: string; state: string; headRefOid: string; baseRefName: string; mergeCommit?: { oid: string } | null; statusCheckRollup: { conclusion?: string; status?: string; state?: string; name?: string; detailsUrl?: string }[] }>(repo,
      ['pr', 'view', branch, '--repo', remote, '--json', 'number,url,state,headRefOid,baseRefName,statusCheckRollup,mergeCommit'])
  }
}
