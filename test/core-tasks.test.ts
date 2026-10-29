import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreTasks, type CoreTask } from '../server/core/tasks.ts'
import { CoreStore } from '../server/core/store.ts'
import type { CoreSource } from '../server/core/source.ts'
import type { Grant } from '../server/core/mailbox.ts'
import type { Message } from '../shared/types.ts'

/** Real local git on CI, fake core boundary; no provider credentials or network needed. */
async function withTask(run: (context: { tasks: CoreTasks; task: CoreTask; grant: Grant; repo: string; worktree: string; git: (cwd: string, ...args: string[]) => void; state: { terminal: string } }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'shep-task-'))
  const repo = join(root, 'repo'), worktree = join(root, 'worktree')
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Core test', GIT_AUTHOR_EMAIL: 'test@localhost', GIT_COMMITTER_NAME: 'Core test', GIT_COMMITTER_EMAIL: 'test@localhost' }
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, env })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  const init = Bun.spawnSync(['git', 'init', '--initial-branch=main', repo], { env })
  if (init.exitCode !== 0) throw new Error(init.stderr.toString())
  writeFileSync(join(repo, 'example.txt'), 'before\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base')
  git(repo, 'worktree', 'add', '-b', 'work/1-example', worktree)
  writeFileSync(join(worktree, 'example.txt'), 'after\n'); git(worktree, 'commit', '-am', 'change')
  const store = new CoreStore(join(root, 'home'))
  const task: CoreTask = { id: 'DEMO-1', name: 'Example', desc: 'Change example.txt', place: 'space', machine: 'machine', repo, folder: worktree,
    branch: 'work/1-example', base: 'main', chat: 'DEMO-1/Agent', kind: 'codex', workflow: 'working', status: 'work', mergePolicy: 'ask',
    review: { on: false, kind: 'codex', rounds: 3, mustFix: 'major' }, age: 'now', created: new Date().toISOString(), on: 'test', state: 'Working' }
  store.set('task', task.id, task)
  const state = { terminal: 'live' }
  const grant = { id: 'grant', chat: task.chat, session: 'launch', machine: task.machine, actions: [] } as unknown as Grant
  const source = {
    store, config: { home: store.home },
    files: { exec: async (_machine: string, argv: string[], cwd?: string, input?: Uint8Array) => {
      const result = Bun.spawnSync(argv, { cwd, env, stdin: input ?? 'ignore' })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout
    } },
    agents: { get: (chat: string) => chat === task.chat ? { chat, launch: grant.session, grant: grant.id, role: 'task', machine: task.machine, kind: 'codex' } : undefined,
      terminal: () => ({ address: 't1', state: state.terminal }), send: async () => {} },
    core: { call: async () => ({}) }, saveAndDeliver: (_chat: string, _id: string, _text: string, save: () => void) => save(), status: () => 'idle', connected: () => true, emit: () => {},
    post: (chat: string, message: Message) => store.set(`message:${chat}`, message.id, message),
  } as unknown as CoreSource
  const tasks = new CoreTasks(source)
  try { await run({ tasks, task, grant, repo, worktree, git, state }) }
  finally { store.close(); rmSync(root, { recursive: true, force: true }) }
}

test('merge requires a human card approval for the exact ready commit', async () => {
  await withTask(async ({ tasks, task, grant, repo }) => {
    await tasks.ready(grant, task.id, 'Changed the example')
    await expect(tasks.merge(grant, task.id)).rejects.toThrow('human must approve')
    expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('before\n')
    const ready = tasks.get(task.id)!
    await tasks.answer(ready.mergeQuestion!, 0, task.chat)
    await tasks.merge(grant, task.id)
    expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('after\n')
    expect(tasks.get(task.id)?.workflow).toBe('merged')
    await expect(tasks.merge(grant, task.id)).resolves.toMatchObject({ workflow: 'merged' })
  })
})

test('a changed commit invalidates an earlier merge card; caller labels cannot authorize another task', async () => {
  await withTask(async ({ tasks, task, grant, worktree, git }) => {
    await tasks.ready(grant, task.id, 'Changed the example')
    const ready = tasks.get(task.id)!
    writeFileSync(join(worktree, 'example.txt'), 'newer\n'); git(worktree, 'commit', '-am', 'newer change')
    await expect(tasks.answer(ready.mergeQuestion!, 0, task.chat)).rejects.toThrow('changed after')
    await expect(tasks.merge({ ...grant, chat: 'OTHER/Agent' }, task.id)).rejects.toThrow('does not own')
    await expect(tasks.merge(grant, task.id)).rejects.toThrow('exact commit ready')
  })
})

test('process exit never marks workflow merged', async () => {
  await withTask(async ({ tasks, task, state }) => {
    state.terminal = 'finished'
    expect(tasks.view(task).status).toBe('need')
    expect(tasks.get(task.id)?.workflow).toBe('working')
  })
})


test('a fresh ready card and Not yet both revoke an earlier approval', async () => {
  await withTask(async ({ tasks, task, grant }) => {
    await tasks.ready(grant, task.id, 'Changed example')
    await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat)
    expect(tasks.get(task.id)!.approvedHead).toBeDefined()
    await tasks.ready(grant, task.id, 'Changed example again')
    expect(tasks.get(task.id)!.approvedHead).toBeUndefined()
    await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 1, task.chat)
    await expect(tasks.merge(grant, task.id)).rejects.toThrow('human must approve')
  })
})


test('review-on ready requires a finished report for the exact commit', async () => {
  await withTask(async ({ tasks, task, grant }) => {
    task.review.on = true
    // Persist the setting, as the real settings action does.
    const source = (tasks as unknown as { source: CoreSource }).source
    source.store.set('task', task.id, task)
    await expect(tasks.ready(grant, task.id, 'Changed example')).rejects.toThrow('fresh review')
  })
})
