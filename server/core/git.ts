import type { CoreFiles } from './files.ts'

export interface RepoLocation { machine: string; folder: string }
export class CoreGit {
  constructor(private readonly files: CoreFiles) {}
  async run(repo: RepoLocation, args: string[], timeout = 30) { return (await this.files.exec(repo.machine, ['git', ...args], repo.folder, undefined, timeout)).toString('utf8').trim() }
  async head(repo: RepoLocation, ref = 'HEAD') { return this.run(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]) }
  async clean(repo: RepoLocation) { return !(await this.run(repo, ['status', '--porcelain'])).length }
  async remote(repo: RepoLocation) {
    try {
      const url = await this.run(repo, ['remote', 'get-url', 'origin'])
      return url.match(/(?:github\.com[:/]|github\.localhost\/)([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]
    } catch { return undefined }
  }
  async gh<T>(repo: RepoLocation, args: string[], timeout = 60): Promise<T> {
    const bytes = await this.files.exec(repo.machine, ['gh', ...args], repo.folder, undefined, timeout)
    const text = bytes.toString('utf8').trim()
    return (text ? JSON.parse(text) : undefined) as T
  }
  async contains(repo: RepoLocation, base: string, head: string) {
    const common = await this.run(repo, ['merge-base', base, head])
    return common === await this.head(repo, head)
  }
  async addWorktree(repo: RepoLocation, folder: string, branch: string, base: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(base) || base.includes('..')) throw new Error('Invalid base branch')
    await this.head(repo, base)
    await this.run(repo, ['worktree', 'add', '-b', branch, folder, base], 60)
  }
  async pullRequest(repo: RepoLocation, branch: string) {
    return this.gh<{ number: number; url: string; state: string; headRefOid: string; baseRefName: string; statusCheckRollup: { conclusion?: string; status?: string; state?: string; name?: string; detailsUrl?: string }[] }>(repo,
      ['pr', 'view', branch, '--json', 'number,url,state,headRefOid,baseRefName,statusCheckRollup'])
  }
}
