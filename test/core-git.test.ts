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

test('reopening a task checkout checks the saved branch/location and preserves occupied paths', async () => {
  let listing = 'worktree /tasks/one\nbranch refs/heads/work/one', branch = true
  const calls: string[][] = []
  const git = new CoreGit({ exec: async (_machine: string, argv: string[]) => {
    calls.push(argv)
    if (argv[1] === 'worktree' && argv[2] === 'list') return Buffer.from(listing)
    if (argv[1] === 'symbolic-ref') return Buffer.from('refs/heads/work/one')
    if (argv[1] === 'for-each-ref') return Buffer.from(branch ? 'refs/heads/work/one ' + 'a'.repeat(40) : '')
    if (argv[1] === 'rev-parse') return Buffer.from('a'.repeat(40))
    if (argv[1] === 'worktree' && argv[2] === 'add') return Buffer.alloc(0)
    throw Error('Unexpected command')
  } } as unknown as CoreFiles)
  const repo = { machine: 'remote', folder: '/repo' }
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.some(args => args.includes('add'))).toBe(false)
  listing = 'worktree /tasks/one\nbranch refs/heads/other'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('another branch')
  listing = 'worktree /tasks/elsewhere\nbranch refs/heads/work/one'
  await expect(git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')).rejects.toThrow('elsewhere')
  listing = ''
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '/tasks/one', 'work/one'])
  branch = false
  await git.ensureWorktree(repo, '/tasks/one', 'work/one', 'main')
  expect(calls.at(-1)).toEqual(['git', 'worktree', 'add', '-b', 'work/one', '/tasks/one', 'main'])
})

test('basic PR identity omits restricted checks and open lookup refuses ambiguous or failed snapshots', async () => {
  let rows: unknown = [], fail = false
  const calls: string[][] = [], git = new CoreGit({} as CoreFiles), repo = { machine: 'remote', folder: '/repo' }
  git.remote = async () => 'github.test/o/r'
  git.gh = async (_repo, args) => { calls.push(args); if (fail) throw Error('GitHub unavailable'); return (args[1] === 'list' ? rows : { number: 1 }) as never }
  await git.pullRequest(repo, 'work/one', false)
  expect(calls.at(-1)?.at(-1)).not.toContain('statusCheckRollup')
  await git.pullRequest(repo, 'work/one')
  expect(calls.at(-1)?.at(-1)).toContain('statusCheckRollup')
  expect(await git.findPullRequest(repo, 'work/one', 'main')).toBeUndefined()
  rows = [{ number: 1, headRefName: 'work/one', baseRefName: 'main' }, { number: 2, headRefName: 'work/one', baseRefName: 'main' }]
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('unambiguous')
  fail = true
  await expect(git.findPullRequest(repo, 'work/one', 'main')).rejects.toThrow('GitHub unavailable')
})
