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
    agents: { all: () => [], get: (chat: string) => chat === task.chat ? { chat, launch: grant.session, grant: grant.id, role: 'task', machine: task.machine, kind: 'codex' } : undefined,
      terminal: () => ({ address: 't1', state: state.terminal }), send: async () => {} },
    core: { current: { terminals: new Map() }, call: async () => ({}) }, saveAndDeliver: (_chat: string, _id: string, _text: string, save: () => void) => save(), status: () => 'idle', connected: () => true, emit: () => {},
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

test('review relay waits for a successful native turn end, not idle or commentary', async () => {
  await withTask(async ({ tasks, task }) => {
    const source = (tasks as unknown as { source: CoreSource }).source
    const original = source.agents.get.bind(source.agents)
    const chat = `${task.id}/Reviewer-1`
    source.agents.get = key => key === chat ? { chat, launch: 'review-launch', role: 'reviewer', state: 'idle' } as ReturnType<typeof original> : original(key)
    Object.defineProperty(source, 'logs', { value: { messages: () => [{ id: 'comment', who: 'agent', text: 'I will inspect', at: 100 }, { id: 'final', who: 'agent', text: 'No findings', at: 200 }] } })
    source.store.set('task', task.id, { ...task, reviewChat: chat, reviewHead: 'head', reviewRound: 1 })
    await tasks.tick()
    expect(tasks.get(task.id)?.reviewReport).toBeUndefined()
    source.store.set(`event:${chat}`, 'turn', { kind: 'turn-end', id: 'turn', at: 300, aborted: true })
    await tasks.tick()
    expect(tasks.get(task.id)?.reviewReport).toBeUndefined()
    source.store.set(`event:${chat}`, 'turn', { kind: 'turn-end', id: 'turn', at: 300 })
    await tasks.tick()
    expect(tasks.get(task.id)).toMatchObject({ reviewReport: 'No findings', reviewTurn: 'turn' })
  })
})


test('checks-only policy cannot silently squash a repository without GitHub checks', async () => {
  await withTask(async ({ tasks, task, grant, repo }) => {
    task.mergePolicy = 'checks'
    const source = (tasks as unknown as { source: CoreSource }).source
    source.store.set('task', task.id, task)
    await tasks.ready(grant, task.id, 'Changed example')
    await expect(tasks.merge(grant, task.id)).rejects.toThrow('requires verified GitHub checks')
    expect(tasks.get(task.id)?.workflow).toBe('ready')
    expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('before\n')
  })
})

test('headless review relay waits for a successful core holder exit', async () => {
  await withTask(async ({ tasks, task }) => {
    const source = (tasks as unknown as { source: CoreSource }).source
    const original = source.agents.get.bind(source.agents), chat = `${task.id}/Reviewer-1`
    source.agents.get = key => key === chat ? { chat, launch: 'review-launch', role: 'reviewer', transcriptFormat: 'codex-exec', state: 'idle' } as ReturnType<typeof original> : original(key)
    let state = 'live', code = 0
    source.agents.terminal = (() => ({ address: 't1', state, exit_code: code })) as unknown as typeof source.agents.terminal
    Object.defineProperty(source, 'logs', { value: { messages: () => [{ id: 'final', who: 'agent', text: 'No findings', at: 200 }] } })
    source.store.set('task', task.id, { ...task, reviewChat: chat, reviewHead: 'head', reviewRound: 1 })
    source.store.set(`event:${chat}`, 'turn', { kind: 'turn-end', id: 'turn', at: 300 })
    await tasks.tick()
    expect(tasks.get(task.id)?.reviewReport).toBeUndefined()
    state = 'finished'; code = 1
    await tasks.tick()
    expect(tasks.get(task.id)?.reviewReport).toBeUndefined()
    expect(tasks.get(task.id)?.reviewFailure).toBe('review-launch')
    code = 0
    await tasks.tick()
    expect(tasks.get(task.id)?.reviewReport).toBe('No findings')
  })
})


test('CLI and screen mutations cannot race a merge already in flight', async () => withTask(async ({ tasks, task, grant, repo }) => {
  await tasks.ready(grant, task.id, 'Changed example')
  await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat)
  const source = (tasks as unknown as { source: CoreSource }).source, exec = source.files.exec.bind(source.files)
  let release!: () => void, entered!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  source.files.exec = async (...args) => {
    if (args[1][0] === 'git' && args[1][1] === 'merge-tree') { entered(); await new Promise<void>(resolve => { release = resolve }) }
    return exec(...args)
  }
  const merge = tasks.merge(grant, task.id)
  await reached
  try {
    for (const args of [['task', 'close', task.id, '--force'], ['todo', task.id], ['task', 'queue', task.id, '--after', 'none']]) await expect(tasks.cli(grant, args)).rejects.toThrow('finishing another action')
    await expect(tasks.act({ type: 'delete', chat: task.chat, force: true })).rejects.toThrow('finishing another action')
    await expect(tasks.ready(grant, task.id, 'Another ready')).rejects.toThrow('finishing another action')
    await expect(tasks.report(grant, task.id, 'Late status', 50)).rejects.toThrow('finishing another action')
    expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('before\n')
  } finally { release() }
  await merge
  expect(tasks.get(task.id)?.workflow).toBe('merged')
  expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('after\n')
}))

test('a task closing its held-work check cannot concurrently start a merge', async () => withTask(async ({ tasks, task, grant, repo }) => {
  await tasks.ready(grant, task.id, 'Changed example')
  await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat)
  const source = (tasks as unknown as { source: CoreSource }).source, exec = source.files.exec.bind(source.files)
  let release!: () => void, entered!: () => void
  const reached = new Promise<void>(resolve => { entered = resolve })
  source.files.exec = async (...args) => {
    if (args[1][0] === 'git' && args[1][1] === 'worktree' && args[1][2] === 'list') { entered(); await new Promise<void>(resolve => { release = resolve }) }
    return exec(...args)
  }
  const close = tasks.close(tasks.get(task.id)!)
  await reached
  try { await expect(tasks.merge(grant, task.id)).rejects.toThrow('finishing another action') }
  finally { release() }
  expect(await close).toMatchObject({ ok: false, held: ['unmerged commits'] })
  expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('before\n')
  await tasks.merge(grant, task.id)
  expect(tasks.get(task.id)?.workflow).toBe('merged')
}))

test('an unchanged squash-merged branch cleans up without force; a new commit remains protected', async () => {
  await withTask(async ({ tasks, task, grant, repo }) => {
    await tasks.ready(grant, task.id, 'Changed example')
    await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat); await tasks.merge(grant, task.id)
    expect(await tasks.close(tasks.get(task.id)!)).toMatchObject({ ok: true })
    expect(tasks.get(task.id)?.workflow).toBe('merged')
    expect(await tasks.remove(tasks.get(task.id)!)).toMatchObject({ ok: true })
    expect(tasks.get(task.id)).toBeUndefined()
    expect(readFileSync(join(repo, 'example.txt'), 'utf8')).toBe('after\n')
  })
  await withTask(async ({ tasks, task, grant, worktree, git }) => {
    await tasks.ready(grant, task.id, 'Changed example')
    await tasks.answer(tasks.get(task.id)!.mergeQuestion!, 0, task.chat); await tasks.merge(grant, task.id)
    writeFileSync(join(worktree, 'later.txt'), 'KEEP_THIS_WORK\n'); git(worktree, 'add', '.'); git(worktree, 'commit', '-m', 'later work')
    expect(await tasks.remove(tasks.get(task.id)!)).toMatchObject({ ok: false, held: ['unmerged commits'] })
    expect(tasks.get(task.id)).toBeDefined()
    expect(readFileSync(join(worktree, 'later.txt'), 'utf8')).toBe('KEEP_THIS_WORK\n')
  })
})

test('queue edits reject missing/self dependencies and ended tasks without corrupting saved workflow', async () => {
  await withTask(async ({ tasks, task, grant }) => {
    for (const ref of ['MISSING-2', task.id]) {
      await expect(tasks.cli(grant, ['task', 'queue', task.id, '--after', ref])).rejects.toThrow()
      expect(tasks.get(task.id)?.workflow).toBe('working')
      expect(tasks.get(task.id)?.after).toBeUndefined()
    }
    await expect(tasks.cli(grant, ['task', 'queue', task.id])).rejects.toThrow('--after')
    await tasks.close(task, true)
    await expect(tasks.cli(grant, ['task', 'queue', task.id, '--after', 'none'])).rejects.toThrow('already closed')
    expect(tasks.get(task.id)?.workflow).toBe('closed')
  })
})

test('an archived queued task never starts in the queue scheduler', async () => {
  await withTask(async ({ tasks, task }) => {
    // Do not need a mocked launcher: starting this record would reach absent launch fixtures and fail to todo.
    const store = (tasks as unknown as { source: CoreSource }).source.store
    store.set('task', task.id, { ...task, workflow: 'queued', after: [], archived: Date.now() })
    await tasks.tick()
    expect(tasks.get(task.id)?.workflow).toBe('queued')
    expect(tasks.get(task.id)?.startError).toBeUndefined()
  })
})

test('task show reports current workflow instead of its initial cached Working text', async () => {
  await withTask(async ({ tasks, task, grant }) => {
    await tasks.cli(grant, ['todo', task.id])
    const shown = JSON.parse((await tasks.cli(grant, ['task', 'show', task.id])).out)
    expect(shown).toMatchObject({ workflow: 'todo', status: 'todo', state: 'To do' })
  })
})

test('Done auto-archive respects native work, scoped off and unarchive delay without touching files', async () => {
  await withTask(async ({ tasks, task, grant, worktree }) => {
    const source = (tasks as unknown as { source: CoreSource }).source
    const now = Date.now(), day = 86_400_000
    let interval = '7 days', phase = 'working'
    Object.assign(source, { space: () => ({ id: task.place }), settings: { get: () => interval } })
    Object.assign(source.agents, { all: () => [{ ...source.agents.get(task.chat)!, state: phase }] })
    source.store.set('task', task.id, { ...task, workflow: 'closed', doneAt: now - 8 * day, pinned: now - 8 * day })
    expect(tasks.autoArchive(now)).toBe(0) // A live conversation must not vanish.
    phase = 'idle'; interval = 'off'
    expect(tasks.autoArchive(now)).toBe(0)
    interval = '7 days'
    expect(tasks.autoArchive(now)).toBe(1)
    expect(tasks.get(task.id)).toMatchObject({ archived: now })
    expect(tasks.get(task.id)?.pinned).toBeUndefined()
    expect(readFileSync(join(worktree, 'example.txt'), 'utf8')).toBe('after\n')
    await tasks.act({ type: 'archive', chat: task.chat, on: false })
    expect(tasks.get(task.id)?.unarchived).toBeGreaterThanOrEqual(now)
    expect(tasks.autoArchive(now + day)).toBe(0)
    expect(tasks.autoArchive(now + 8 * day)).toBe(1)
    await expect(tasks.cli(grant, ['task', 'show', task.id])).resolves.toHaveProperty('out')
  })
})

test('task controls require a coordinator and lists separate archived tasks in its own machine and space', async () => {
  await withTask(async ({ tasks, task, grant }) => {
    const source = (tasks as unknown as { source: CoreSource }).source
    for (const command of ['pin', 'unpin', 'pause', 'archive', 'unarchive', 'delete', 'close']) {
      await expect(tasks.cli(grant, ['task', command, task.id])).rejects.toThrow('Only a coordinator')
    }
    source.agents.get = (() => ({ chat: grant.chat, launch: grant.session, grant: grant.id, role: 'coordinator', machine: task.machine, space: task.place, kind: 'codex', hook: '/unused', started: 1, state: 'idle' })) as typeof source.agents.get
    source.store.set('task', 'OTHER-1', { ...task, id: 'OTHER-1', machine: 'other' })
    source.store.set('task', 'OTHER-2', { ...task, id: 'OTHER-2', place: 'other' })
    expect(tasks.list(grant).map(t => t.id)).toEqual([task.id])
    await tasks.cli(grant, ['task', 'pin', task.id]); expect(tasks.get(task.id)?.pinned).toBeNumber()
    await tasks.cli(grant, ['task', 'archive', task.id])
    expect(tasks.get(task.id)?.pinned).toBeUndefined()
    expect(tasks.list(grant)).toEqual([])
    expect(tasks.list(grant, true).map(t => t.id)).toEqual([task.id])
    await tasks.cli(grant, ['task', 'unarchive', task.id]); expect(tasks.list(grant).map(t => t.id)).toEqual([task.id])
    await tasks.cli(grant, ['task', 'pause', task.id]); expect(tasks.get(task.id)?.workflow).toBe('todo')
    await tasks.cli(grant, ['task', 'unpin', task.id]); expect(tasks.get(task.id)?.pinned).toBeUndefined()
  })
})
