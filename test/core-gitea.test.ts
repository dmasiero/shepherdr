// Fork (dmasiero/shepherdr): Gitea pull requests through tea (server/core/forge.ts, gitea.ts, tea.ts, follow-up.ts).
// Real local git and a bare origin; tea is test/fake-tea.ts, which keeps its Gitea in a JSON file.
import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreTasks, type CoreTask } from '../server/core/tasks.ts'
import { CoreStore } from '../server/core/store.ts'
import { CoreForgeGit, giteaWords, remoteOf } from '../server/core/forge.ts'
import { parseAnswer, parseLogins, serves, teaArgv, teaFailure, TEA_MISSING } from '../server/core/tea.ts'
import type { CoreFiles } from '../server/core/files.ts'
import type { CoreSource } from '../server/core/source.ts'
import type { Grant } from '../server/core/mailbox.ts'
import type { Message } from '../shared/types.ts'
import { fakeTea, type FakeGitea } from './fake-tea.ts'

const env = { ...process.env, GIT_AUTHOR_NAME: 'Core test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Core test', GIT_COMMITTER_EMAIL: 'test@localhost' }
const run = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}
/** a core machine.exec on this machine, with `path` first on PATH: as CoreFiles answers */
const files = (path: string) => ({ exec: async (_machine: string, argv: string[], cwd?: string, input?: Uint8Array) => {
  const result = Bun.spawnSync(argv, { cwd, env: { ...env, PATH: `${path}:${process.env.PATH}`, FAKE_TEA_STATE: join(path, '..', 'fake-tea.json') }, stdin: input ?? 'ignore' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `Command exited with ${result.exitCode}`)
  return result.stdout
} }) as unknown as CoreFiles

interface World { tasks: CoreTasks; task: CoreTask; grant: Grant; repo: string; worktree: string; origin: string; tea: ReturnType<typeof fakeTea>; root: string }

/** a task whose repo's origin is on Gitea (https://gitea.test/o/r, rewritten to a bare repo here) */
async function withGitea(go: (world: World) => Promise<void>, state: Partial<FakeGitea> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'shep-gitea-'))
  const repo = join(root, 'repo'), worktree = join(root, 'worktree'), origin = join(root, 'origin.git')
  run(root, 'init', '--initial-branch=main', repo); run(root, 'init', '--bare', '--initial-branch=main', origin)
  writeFileSync(join(repo, 'example.txt'), 'before\n'); run(repo, 'add', '.'); run(repo, 'commit', '-m', 'base')
  run(repo, 'remote', 'add', 'origin', 'https://gitea.test/o/r.git')
  run(repo, 'config', `url.${origin}.insteadOf`, 'https://gitea.test/o/r.git')
  run(repo, 'push', '-q', 'origin', 'main')
  run(repo, 'worktree', 'add', '-b', 'work/1-example', worktree)
  writeFileSync(join(worktree, 'example.txt'), 'after\n'); run(worktree, 'commit', '-am', 'change')
  const tea = fakeTea(root, { origin, repo: 'o/r', url: 'https://gitea.test', prs: [], calls: [], ...state })
  const store = new CoreStore(join(root, 'home'))
  const task: CoreTask = { id: 'DEMO-1', name: 'Example', desc: 'Change example.txt', place: 'space', machine: 'machine', repo, folder: worktree,
    branch: 'work/1-example', base: 'main', chat: 'DEMO-1/Agent', kind: 'codex', workflow: 'working', status: 'work', mergePolicy: 'ask',
    review: { on: false, kind: 'codex', rounds: 3, mustFix: 'major' }, age: 'now', created: new Date().toISOString(), on: 'test', state: 'Working' }
  store.set('task', task.id, task)
  const grant = { id: 'grant', chat: task.chat, session: 'launch', machine: task.machine, actions: [] } as unknown as Grant
  const source = {
    store, config: { home: store.home }, space: () => ({ id: 'space', name: 'demo', machine: 'machine', folder: repo, mode: 'regular', base: 'main', prefix: 'DEMO', added: 1 }), settings: { get: () => 'off' },
    files: files(tea.bin),
    agents: { all: () => [], get: (chat: string) => chat === task.chat ? { chat, launch: grant.session, grant: grant.id, role: 'task', machine: task.machine, space: task.place, kind: 'codex' } : undefined,
      terminal: () => ({ address: 't1', state: 'live' }), send: async () => {} },
    browsers: { close: async () => {} }, github: { prs: { comments: async () => [] } },
    core: { current: { terminals: new Map() }, call: async () => ({}) }, saveAndDeliver: (_chat: string, _id: string, _text: string, save: () => void) => save(), status: () => 'idle', connected: () => true, emit: () => {},
    post: (chat: string, message: Message) => store.set(`message:${chat}`, message.id, message),
  } as unknown as CoreSource
  const tasks = new CoreTasks(source)
  tasks.seedIncludes = async () => {}
  try { await go({ tasks, task, grant, repo, worktree, origin, tea, root }) }
  finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}

/** the task is ready and its merge card answered Merge */
async function readyAndApproved({ tasks, task, grant }: World, summary = 'Changed the example') {
  await tasks.ready(grant, task.id, summary, 'Only example.txt')
  await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat)
}

test('tea api -i answers parse into status and body; logins and hosts match', () => {
  const answer = parseAnswer('HTTP/1.1 404 Not Found\nVia: 1.1 Caddy\nContent-Type: application/json\n\n{"message":"not found"}')
  expect(answer).toMatchObject({ code: 404, body: { message: 'not found' } })
  expect(parseAnswer('HTTP/1.1 204 No Content\nVia: x')).toMatchObject({ code: 204, body: null, text: '' })
  expect(() => parseAnswer('Error: login name \'x\' does not exist')).toThrow('did not report')
  const [login] = parseLogins('[{"name":"masiero","url":"https://gitea.masiero.internal","ssh_host":"gitea.masiero.internal","user":"doug"}]')
  expect(serves(login, 'GITEA.masiero.internal')).toBe(true)
  expect(serves({ name: 'x', url: 'https://code.example.org:3000/', sshHost: '' }, 'code.example.org')).toBe(true)
  expect(parseLogins('')).toEqual([])
  expect(teaFailure(Error('sh: line 1: tea: command not found'))).toBe(TEA_MISSING)
  expect(remoteOf('ssh://git@gitea.masiero.internal:2222/doug/renix.git')).toEqual({ host: 'gitea.masiero.internal', repo: 'doug/renix' })
  expect(remoteOf('/srv/git/repo.git')).toBeUndefined()
  expect(giteaWords('Merge: after GitHub checks. Run gh auth status. GitHub Copilot stays.')).toBe('Merge: after Gitea checks. Run tea login list. GitHub Copilot stays.')
})

test('tea runs through sh with its status lines kept, and its failure says why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tea-'))
  try {
    const tea = fakeTea(root, { origin: root, repo: 'o/r', url: 'https://gitea.test', prs: [], calls: [] })
    const exec = files(tea.bin).exec
    const out = (await exec('m', [...teaArgv(['api', '--login', 'test', '-i', '-X', 'GET', 'user'])], root)).toString()
    expect(parseAnswer(out)).toMatchObject({ code: 200, body: { login: 't' } })
    await expect(exec('m', teaArgv(['api', '--login', 'nobody', '-i', 'user']), root)).rejects.toThrow("login name 'nobody' does not exist")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('forge choice: GitHub origins never ask tea; a Gitea host is Gitea; shepherdr.forge decides when set', async () => withGitea(async ({ tasks, repo, tea }) => {
  const location = { machine: 'machine', folder: repo }
  expect(await tasks.git.giteaTarget(location)).toEqual({ host: 'gitea.test', repo: 'o/r', login: 'test', url: 'https://gitea.test' })
  expect(await tasks.git.remote(location)).toBe('gitea.test/o/r')
  expect(tasks.git.known(location)).toBe('gitea')
  const fresh = () => new CoreForgeGit(files(tea.bin))
  run(repo, 'config', 'shepherdr.forge', 'github')
  expect(await fresh().giteaTarget(location)).toBeUndefined()
  run(repo, 'config', '--unset', 'shepherdr.forge')
  run(repo, 'remote', 'set-url', 'origin', 'git@github.com:o/r.git')
  const calls = tea.read().calls.length
  expect(await fresh().giteaTarget(location)).toBeUndefined()
  expect(await fresh().remote(location)).toBe('github.com/o/r')
  expect(tea.read().calls.length).toBe(calls)
  // A host no login serves: a Gitea-named one says so, any other has no pull requests (merges here, as upstream).
  run(repo, 'remote', 'set-url', 'origin', 'https://gitea.other.test/o/r.git')
  await expect(fresh().giteaTarget(location)).rejects.toThrow('tea is not logged in to gitea.other.test')
  run(repo, 'remote', 'set-url', 'origin', 'https://code.other.test/o/r.git')
  expect(await fresh().giteaTarget(location)).toBeUndefined()
  run(repo, 'config', 'shepherdr.forge', 'gitea')
  await expect(fresh().giteaTarget(location)).rejects.toThrow('tea is not logged in to code.other.test')
  // No tea at all: a Gitea host is refused, never merged here.
  const noTea = () => new CoreForgeGit({ exec: async (machine: string, argv: string[], cwd?: string, input?: Uint8Array) => argv[0] === 'sh' ? Promise.reject(Error('sh: line 1: tea: command not found')) : files(tea.bin).exec(machine, argv, cwd, input) } as unknown as CoreFiles)
  await expect(noTea().giteaTarget(location)).rejects.toThrow(TEA_MISSING)
  run(repo, 'config', '--unset', 'shepherdr.forge')
  expect(await noTea().giteaTarget(location)).toBeUndefined() // code.other.test: nothing says Gitea
  run(repo, 'remote', 'set-url', 'origin', 'https://gitea.test/o/r.git')
  await expect(noTea().giteaTarget(location)).rejects.toThrow(TEA_MISSING)
}))

test('a task on Gitea: draft opened, readied with its summary, held on checks, squash-merged at its head and synced', async () => withGitea(async (world) => {
  const { tasks, task, grant, repo, worktree, tea } = world
  const pr = await tasks.pr(grant, task.id)
  expect(pr).toEqual({ number: 1, url: 'https://gitea.test/o/r/pulls/1' })
  expect(tea.read().prs[0]).toMatchObject({ head: 'work/1-example', base: 'main', title: 'WIP: DEMO-1: Example', body: 'Change example.txt', state: 'open' })
  expect(await tasks.pr(grant, task.id)).toEqual(pr) // Again: the same pull request, none opened twice.
  expect(tea.read().prs.length).toBe(1)
  await readyAndApproved(world)
  expect(tea.read().prs[0]).toMatchObject({ title: 'DEMO-1: Example', body: 'Changed the example\n\nFacts: Only example.txt' })
  tea.write({ ...tea.read(), statuses: [{ context: 'check / test', status: 'pending', target_url: '/o/r/actions/runs/1/jobs/0' }] })
  const pending = await tasks.git.pullRequest({ machine: task.machine, folder: worktree }, task.branch)
  expect(pending.statusCheckRollup).toEqual([{ name: 'check / test', context: 'check / test', state: 'PENDING', targetUrl: 'https://gitea.test/o/r/actions/runs/1/jobs/0' }])
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('Gitea checks are not green')
  tea.write({ ...tea.read(), statuses: [{ context: 'check / test', status: 'failure' }] })
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('checks are not green')
  tea.write({ ...tea.read(), statuses: [{ context: 'check / test', status: 'success' }, { context: 'lint', status: 'warning' }] })
  const merged = await tasks.merge(grant, task.id)
  const gitea = tea.read()
  expect(gitea.prs[0]).toMatchObject({ state: 'closed', merged: true })
  expect(gitea.calls.find(call => call.path.endsWith('/pulls/1/merge'))?.body).toEqual({ Do: 'squash', head_commit_id: run(worktree, 'rev-parse', 'HEAD'), delete_branch_after_merge: false })
  expect(merged).toMatchObject({ workflow: 'merged', mergeCommit: gitea.prs[0].mergeCommit, baseSyncPending: true })
  await tasks.syncBase(task.id)
  expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('after\n')
  expect(tasks.get(task.id)?.baseSyncPending).toBeUndefined()
}))

test('a required status not shown yet holds the merge; a commit with no statuses has no checks', async () => withGitea(async (world) => {
  const { tasks, task, grant, worktree, tea } = world
  await tasks.pr(grant, task.id)
  await readyAndApproved(world)
  const location = { machine: task.machine, folder: worktree }
  // Gitea says "pending" for a commit with no statuses at all: that is no check, as GitHub's empty rollup.
  tea.write({ ...tea.read(), combined: 'pending', statuses: [] })
  expect((await tasks.git.pullRequest(location, task.branch)).statusCheckRollup).toEqual([])
  tea.write({ ...tea.read(), combined: undefined, protections: [{ rule_name: 'main', enable_status_check: true, status_check_contexts: ['ci / build', 'pattern/*'] }] })
  expect((await tasks.git.pullRequest(location, task.branch)).statusCheckRollup).toEqual([{ name: 'ci / build', context: 'ci / build', state: 'PENDING' }])
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('checks are not green')
  tea.write({ ...tea.read(), statuses: [{ context: 'ci / build', status: 'success' }] })
  await expect(tasks.merge(grant, task.id)).resolves.toMatchObject({ workflow: 'merged' })
}))

test('Gitea refuses a merge at a moved head and says a conflict is one', async () => withGitea(async (world) => {
  const { tasks, task, grant, repo, worktree, tea } = world
  await tasks.pr(grant, task.id)
  await readyAndApproved(world)
  const gitea = await tasks.git.gitea({ machine: task.machine, folder: worktree })
  await expect(gitea!.merge(1, 'b'.repeat(40))).rejects.toThrow('head out of date')
  // main moves on with a change to the same line: the pull request conflicts
  writeFileSync(join(repo, 'example.txt'), 'other\n'); run(repo, 'commit', '-am', 'other'); run(repo, 'push', '-q', 'origin', 'main')
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('Conflict with the base branch')
  expect(tea.read().prs[0]).toMatchObject({ state: 'open' })
}))

test('a Gitea pull request merged by hand at an earlier commit: work since opens a follow-up, nothing since is the merge', async () => withGitea(async (world) => {
  const { tasks, task, grant, worktree, tea } = world
  await tasks.pr(grant, task.id)
  await readyAndApproved(world)
  // Someone merges it on Gitea; the agent goes on and commits more.
  const gitea = await tasks.git.gitea({ machine: task.machine, folder: worktree })
  await gitea!.ready(1); await gitea!.merge(1, run(worktree, 'rev-parse', 'HEAD'))
  writeFileSync(join(worktree, 'more.txt'), 'more\n'); run(worktree, 'add', '.'); run(worktree, 'commit', '-m', 'more')
  // Ready again is refused (its pull request is merged); shepherdr pr opens the follow-up.
  await expect(tasks.ready(grant, task.id, 'More')).rejects.toThrow('open pull request')
  expect(await tasks.pr(grant, task.id)).toEqual({ number: 2, url: 'https://gitea.test/o/r/pulls/2' })
  expect(tea.read().prs[1]).toMatchObject({ title: 'WIP: DEMO-1: Example (follow-up)', state: 'open' })
  expect(tea.read().prs[1].body).toStartWith('Follow-up to #1 (https://gitea.test/o/r/pulls/1).')
  await readyAndApproved(world, 'More')
  await expect(tasks.merge(grant, task.id)).resolves.toMatchObject({ workflow: 'merged', pr: { number: 2 } })
  expect(tea.read().prs[1]).toMatchObject({ merged: true })
}))

/** a pull request the task never recorded, opened by hand from its branch and merged at its first commit */
async function mergedByHand({ tasks, task, worktree }: World) {
  run(worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${task.branch}`)
  const gitea = (await tasks.git.gitea({ machine: task.machine, folder: worktree }))!
  await gitea.create({ branch: task.branch, base: 'main', title: 'By hand', body: '', draft: false })
  await gitea.merge(1, run(worktree, 'rev-parse', 'HEAD'))
}

test('merge finds an unrecorded merged pull request with work since: its follow-up opens and the merge stops', async () => withGitea(async (world) => {
  const { tasks, task, grant, worktree, tea } = world
  await mergedByHand(world)
  writeFileSync(join(worktree, 'more.txt'), 'more\n'); run(worktree, 'add', '.'); run(worktree, 'commit', '-m', 'more')
  await readyAndApproved(world)
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('opened follow-up PR #2')
  expect(tasks.get(task.id)).toMatchObject({ pr: { number: 2 }, workflow: 'ready' })
  expect(tasks.get(task.id)?.readyHead).toBeUndefined()
  expect(tea.read().prs[1]).toMatchObject({ title: 'WIP: DEMO-1: Example (follow-up)', head: task.branch, state: 'open' })
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('exact commit ready')
  await readyAndApproved(world, 'More')
  const merged = await tasks.merge(grant, task.id)
  expect(merged).toMatchObject({ workflow: 'merged', pr: { number: 2 } })
  expect(merged.mergeCommit).toBe(tea.read().prs[1].mergeCommit!)
}))

test('merge finds an unrecorded merged pull request with nothing new since: that merge was the task’s', async () => withGitea(async (world) => {
  const { tasks, task, grant, worktree, tea } = world
  await mergedByHand(world)
  run(worktree, 'commit', '--allow-empty', '-m', 'nothing')
  await readyAndApproved(world)
  await expect(tasks.merge(grant, task.id)).resolves.toMatchObject({ workflow: 'merged', mergeCommit: tea.read().prs[0].mergeCommit })
  expect(tea.read().prs.length).toBe(1)
}))

test('GitHub keeps upstream’s refusal for a pull request merged at an earlier commit', async () => withGitea(async (world) => {
  const { tasks, task, grant, repo } = world
  run(repo, 'config', 'shepherdr.forge', 'github')
  await readyAndApproved(world)
  const head = run(world.worktree, 'rev-parse', 'HEAD'), calls: string[][] = []
  tasks.git.remote = async () => 'github.test/o/r'
  tasks.git.pullRequest = async () => ({ number: 1, url: 'https://github.test/o/r/pull/1', state: 'MERGED', headRefOid: 'b'.repeat(40), baseRefName: 'main', mergeCommit: { oid: 'c'.repeat(40) }, statusCheckRollup: [] })
  tasks.git.ghRun = async (_repo, args) => { calls.push(args); return '' }
  await expect(tasks.merge(grant, task.id)).rejects.toThrow('head or base differs')
  expect(calls).toEqual([])
  expect(head).toMatch(/^[a-f0-9]{40}$/)
}))

test('reviews, line comments and comments read in github-pr shapes; the panel shows the pull request and its checks', async () => withGitea(async (world) => {
  const { tasks, task, grant, worktree, tea } = world
  await tasks.pr(grant, task.id)
  const root = 'repos/o/r'
  tea.write({ ...tea.read(), statuses: [{ context: 'ci', status: 'failure', target_url: 'https://gitea.test/o/r/actions/runs/3/jobs/0' }], api: {
    [`${root}/pulls/1/reviews`]: [{ id: 5, user: { login: 'doug' }, body: 'Please fix', state: 'REQUEST_CHANGES', submitted_at: '2026-10-30T10:00:00Z', comments_count: 1, html_url: 'https://gitea.test/o/r/pulls/1#r5' },
      { id: 6, user: { login: 'doug' }, body: '', state: 'PENDING', comments_count: 0 }],
    [`${root}/pulls/1/reviews/5/comments`]: [{ id: 7, user: { login: 'doug' }, body: 'here', path: 'example.txt', line: 1, created_at: '2026-10-30T09:59:00Z', html_url: 'https://gitea.test/o/r/pulls/1#c7' }],
    [`${root}/issues/1/comments`]: [{ id: 8, user: { login: 'eve' }, body: 'Looks good', created_at: '2026-10-30T11:00:00Z', html_url: 'https://gitea.test/o/r/pulls/1#i8' }],
  } })
  const gitea = (await tasks.git.gitea({ machine: task.machine, folder: worktree }))!
  expect(await gitea.comments(1)).toEqual([
    { id: 'c7', at: Date.parse('2026-10-30T10:00:00Z'), who: 'doug', body: 'here', url: 'https://gitea.test/o/r/pulls/1#c7', where: 'example.txt:1' },
    { id: 'r5', at: Date.parse('2026-10-30T10:00:00Z'), who: 'doug', body: 'Please fix', url: 'https://gitea.test/o/r/pulls/1#r5', state: 'CHANGES_REQUESTED' },
    { id: 'i8', at: Date.parse('2026-10-30T11:00:00Z'), who: 'eve', body: 'Looks good', url: 'https://gitea.test/o/r/pulls/1#i8' },
  ])
  expect(await gitea.panel(task.branch)).toEqual({ pr: { number: 1, title: 'DEMO-1: Example', state: 'draft', url: 'https://gitea.test/o/r/pulls/1', checks: [{ name: 'ci', state: 'fail', url: 'https://gitea.test/o/r/actions/runs/3/jobs/0' }] } })
  expect(await gitea.panel('work/none')).toEqual({ pr: null, why: 'No pull request yet.' })
}))

test('the Settings block and skills say Gitea in a Gitea space and GitHub elsewhere', async () => withGitea(async ({ tasks, repo }) => {
  const location = { machine: 'machine', folder: repo }
  expect((await tasks.git.words(location))('Merge: after GitHub checks')).toBe('Merge: after Gitea checks')
  run(repo, 'config', 'shepherdr.forge', 'github')
  expect((await new CoreForgeGit(files(join(repo, '..', 'fake-tea-bin'))).words(location))('Merge: after GitHub checks')).toBe('Merge: after GitHub checks')
}))

test('the contained repository runner runs tea and keeps its status lines with the answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-tea-pilot-')), repo = join(root, 'repo')
  try {
    run(root, 'init', '--initial-branch=main', repo)
    const tea = fakeTea(root, { origin: repo, repo: 'o/r', url: 'https://gitea.test', prs: [], calls: [] })
    // The runner as core runs it: its own process, the command as JSON on stdin.
    const runner = (args: string[]) => Bun.spawnSync([process.execPath, join(import.meta.dir, '../helper/core-pilot-git.ts')], { env: { ...process.env, PATH: `${tea.bin}:${process.env.PATH}`, FAKE_TEA_STATE: tea.file },
      stdin: Buffer.from(JSON.stringify({ repo, cwd: repo, tool: 'tea', args, writableRoots: [] })) })
    const ok = runner(['api', '--login', 'test', '-i', '-X', 'GET', 'user'])
    expect(ok.exitCode).toBe(0)
    expect(parseAnswer(ok.stdout.toString('utf8'))).toMatchObject({ code: 200, body: { login: 't' } })
    const refused = runner(['api', '--login', 'nobody', 'user'])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.toString('utf8')).toContain("login name 'nobody' does not exist")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
