import { expect, test } from 'bun:test'
import { CoreGit, githubRemote } from '../server/core/git.ts'
import type { CoreFiles } from '../server/core/files.ts'

test('GitHub remote forms retain their explicit host including legacy enterprise and rewritten hosts', () => {
  for (const url of ['git@github.company.test:owner/repo.git', 'ssh://git@github.company.test:2222/owner/repo.git', 'https://github.company.test/owner/repo.git/']) expect(githubRemote(url)).toBe('github.company.test/owner/repo')
  expect(githubRemote('http://github.localhost/owner/repo.git')).toBe('github.localhost/owner/repo')
  expect(githubRemote('/tmp/local.git')).toBeUndefined()
  expect(githubRemote('https://gitlab.com/owner/repo')).toBeUndefined()
})

test('GitHub routing checks effective and written origin and refuses uncertain reads before local fallback', async () => {
  let used = 'git@ssh-alias:owner/repo.git', written = 'https://github.com/owner/repo.git', fail = false, origin = true
  const calls: string[][] = []
  const files = { exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'remote' && argv.length === 2) return Buffer.from(origin ? 'origin\n' : '')
    if (fail) throw Error('Core machine disconnected')
    if (argv[1] === 'remote') return Buffer.from(used)
    if (argv[1] === 'config') return Buffer.from(written)
    if (argv[0] === 'gh') return Buffer.from('{}')
    throw Error('Unexpected command')
  } } as unknown as CoreFiles
  const git = new CoreGit(files), repo = { machine: 'remote', folder: '/repo' }
  expect(await git.remote(repo)).toBe('github.com/owner/repo')
  used = 'http://github.localhost/owner/repo.git'
  expect(await git.remote(repo)).toBe('github.localhost/owner/repo')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)).toContain('--repo')
  expect(calls.at(-1)).toContain('github.localhost/owner/repo')
  fail = true
  await expect(git.remote(repo)).rejects.toThrow('Core machine disconnected')
  fail = false; origin = false
  expect(await git.remote(repo)).toBeUndefined()
})
