// fork: task commands for scripts (FORK.md, server/core/operator-tasks.ts, helper/operator-tasks.ts)
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreSource } from '../server/core/source.ts'
import { operatorRequest, startOperator } from '../server/core/operator.ts'
import { taskStdin } from '../helper/operator-tasks.ts'
import type { CoreTask, CoreTaskInput } from '../server/core/tasks.ts'
import type { CoreSpace } from '../server/core/model.ts'
import type { Action } from '../shared/types.ts'

async function withOperator(run: (context: { source: CoreSource; ask: (args: string[], stdin?: string) => Promise<{ out: string; code: number }>; added: { space: string; input: CoreTaskInput }[]; sent: Action[] }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'shep-op-tasks-'))
  const source = new CoreSource({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const machine = source.localMachineId()
  const space = (id: string, name: string, prefix: string, extra: Partial<CoreSpace> = {}): CoreSpace => ({ id, name, machine, folder: `/isolated/${name}`, base: 'main', prefix, mode: 'regular', added: 1, ...extra } as CoreSpace)
  source.store.set('space', 'ops', space('ops', 'ops', 'OPS'))
  source.store.set('space', 'infra', space('infra', 'infra', 'INF'))
  source.store.set('space', 'home', space('home', '~', 'HOM', { home: true }))
  source.store.set('space', 'far', { ...space('far', 'far', 'FAR'), machine: 'other-machine' })
  const task = (id: string, place: string, workflow: CoreTask['workflow'], extra: Partial<CoreTask> = {}) => source.store.set('task', id, {
    id, localId: id, name: `Task ${id}`, desc: 'brief', place, machine: source.space(place)?.machine ?? machine, folder: `/isolated/wt/${id}`, repo: '/isolated/repo',
    branch: `work/${id}`, base: 'main', chat: `${id}/Agent`, kind: 'claude', workflow, status: 'work', mergePolicy: 'ask', after: [], age: 'now', created: new Date().toISOString(), on: 'Claude Code', state: 'Working', ...extra } as CoreTask)
  task('OPS-1', 'ops', 'working', { pr: { number: 7, url: 'https://gitea.example/doug/ops/pulls/7' } })
  task('OPS-2', 'ops', 'merged')
  task('INF-3', 'infra', 'closed', { archived: 5 })
  task('FAR-1', 'far', 'working')
  const added: { space: string; input: CoreTaskInput }[] = [], sent: Action[] = []
  source.tasks.addInSpace = async (target, input) => {
    added.push({ space: target.id, input })
    return { id: `${target.prefix}-9`, name: input.title, branch: 'work/9-x', workflow: input.after?.length ? 'queued' : input.later ? 'todo' : 'working', after: input.after } as CoreTask
  }
  source.act = async action => { sent.push(action); return {} }
  const operator = await startOperator(source, randomUUID())
  try { await run({ source, ask: (args, stdin) => operatorRequest(home, operator.path, args, stdin), added, sent }) }
  finally { operator.close(); source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
}

test('task add through the operator socket adds in the named space with the brief from stdin, in 2.0’s words', () => withOperator(async ({ ask, added }) => {
  const brief = 'A brief longer than a command word. '.repeat(40)
  const result = await ask(['task', 'add', 'CW42: Phones down', '--space', 'ops', '--set', 'merge=ask me first', '--after', 'OPS-1'], brief)
  expect(result.code).toBe(0)
  // shepherdr_board.py reads the id from this first line.
  expect(result.out).toMatch(/^Added OPS-9: CW42: Phones down\. Its agent waits for OPS-1\.\n/)
  expect(added).toEqual([{ space: 'ops', input: expect.objectContaining({ title: 'CW42: Phones down', brief, after: ['OPS-1'], later: false, settings: { 'brief.merge': 'ask me first' } }) }])
  expect((await ask(['task', 'add', 'Later', '--space', 'infra', '--later'], 'x')).out).toStartWith('Added INF-9: Later. Its agent waits for a go.')
}))

test('task add refuses a missing space or brief, a brief in command words, another machine’s space and the home space', () => withOperator(async ({ ask, added }) => {
  expect(await ask(['task', 'add', 'T'], 'brief')).toEqual({ code: 1, out: 'Choose the task’s space with --space NAME\n' })
  expect((await ask(['task', 'add', 'T', '--space', 'ops'])).out).toContain('full brief on stdin')
  expect((await ask(['task', 'add', 'T', '--space', 'ops'], '  \n')).out).toContain('full brief on stdin')
  expect((await ask(['task', 'add', 'T', '--space', 'ops', '--brief', 'b'])).out).toContain('on stdin, never in command words')
  expect((await ask(['task', 'add', 'T', '--space', 'far'], 'b')).out).toContain('No repository space far on the main machine')
  expect((await ask(['task', 'add', 'T', '--space', '~'], 'b')).out).toContain('No repository space ~')
  expect((await ask(['task', 'add', 'T', '--space', 'ops', '--json'], 'b')).out).toContain('Task add takes no --json')
  expect(added).toEqual([])
}))

test('task list --json gives 2.0’s rows of the main machine’s tasks, open or archived', () => withOperator(async ({ ask }) => {
  const open = JSON.parse((await ask(['task', 'list', '--json'])).out)
  expect(open.map((row: { id: string }) => row.id)).toEqual(['OPS-1', 'OPS-2'])
  expect(open[0]).toMatchObject({ id: 'OPS-1', title: 'Task OPS-1', space: 'ops' })
  expect(open[1]).toMatchObject({ id: 'OPS-2', status: 'done' })
  expect(JSON.parse((await ask(['task', 'list', '--json', '--archived'])).out)).toEqual([expect.objectContaining({ id: 'INF-3', status: 'done', archived: 5 })])
  expect(JSON.parse((await ask(['task', 'list', '--json', '--space', 'infra'])).out)).toEqual([])
  expect((await ask(['task', 'list'])).out).toContain('OPS-2 · Merged · ops · Task OPS-2')
  expect((await ask(['task', 'list', '--space', 'far'])).code).toBe(1)
}))

test('task show --json gives the task’s pull request', () => withOperator(async ({ ask }) => {
  expect(JSON.parse((await ask(['task', 'show', 'OPS-1', '--json'])).out)).toMatchObject({ id: 'OPS-1', branch: 'work/OPS-1', pr: { number: 7, url: 'https://gitea.example/doug/ops/pulls/7' } })
  expect(await ask(['task', 'show', 'FAR-1'])).toEqual({ code: 1, out: 'No task FAR-1 on the main machine\n' })
}))

test('task tell sends the message from stdin to an open task and refuses unknown and Done tasks', () => withOperator(async ({ ask, sent }) => {
  expect(await ask(['task', 'tell', 'OPS-1'], 'New message on the ticket')).toEqual({ code: 0, out: 'Told OPS-1.\n' })
  expect(sent).toEqual([expect.objectContaining({ type: 'send', chat: 'OPS-1/Agent', text: 'New message on the ticket' })])
  // shepherdr_board.GONE_RE is \bNo task\b
  expect((await ask(['task', 'tell', 'OPS-404'], 'hi')).out).toStartWith('No task OPS-404')
  expect((await ask(['task', 'tell', 'OPS-2'], 'hi')).out).toContain('OPS-2 is Done; add a new task instead')
  expect((await ask(['task', 'tell', 'INF-3'], 'hi')).out).toContain('INF-3 is archived')
  expect((await ask(['task', 'tell', 'OPS-1'])).out).toContain('message on stdin')
  expect((await ask(['task', 'tell', 'OPS-1', 'words'], 'hi')).code).toBe(1)
  expect(sent).toHaveLength(1)
}))

test('other task commands and agents’ own commands stay refused on the operator socket', () => withOperator(async ({ ask }) => {
  for (const args of [['task', 'close', 'OPS-1'], ['task', 'merge', 'OPS-1'], ['ready', 'OPS-1'], ['task', 'queue', 'OPS-1', '--after', 'none']]) expect((await ask(args)).code).toBe(1)
}))

test('the helper moves 2.0’s --brief and tell words to stdin, or reads stdin', async () => {
  const none = Object.assign((async function* () {})(), { isTTY: true })
  expect(await taskStdin(['task', 'add', 'T', '--space', 'ops', '--brief', 'the brief', '--set', 'merge=ask me first'], none)).toEqual([['task', 'add', 'T', '--space', 'ops', '--set', 'merge=ask me first'], 'the brief'])
  expect(await taskStdin(['task', 'add', 'T', '--desc=x=y', '--space', 'ops'], none)).toEqual([['task', 'add', 'T', '--space', 'ops'], 'x=y'])
  expect(await taskStdin(['task', 'tell', 'OPS-1', 'two', 'words'], none)).toEqual([['task', 'tell', 'OPS-1'], 'two words'])
  expect(await taskStdin(['task', 'tell', 'OPS-1', '--home', '/tmp/h', 'hi'], none)).toEqual([['task', 'tell', 'OPS-1', '--home', '/tmp/h'], 'hi'])
  expect(await taskStdin(['task', 'tell', 'OPS-1', 'say', '--home'], none)).toEqual([['task', 'tell', 'OPS-1'], 'say --home'])
  expect(await taskStdin(['task', 'add', 'T', '--brief', '--home', '--home', '/tmp/h'], none)).toEqual([['task', 'add', 'T', '--home', '/tmp/h'], '--home'])
  expect(await taskStdin(['task', 'list', '--json'], none)).toEqual([['task', 'list', '--json'], undefined])
  expect(await taskStdin(['task', 'tell', 'OPS-1'], none)).toEqual([['task', 'tell', 'OPS-1'], undefined])
  const piped = (async function* () { yield new TextEncoder().encode('from ') ; yield new TextEncoder().encode('stdin') })()
  expect(await taskStdin(['task', 'add', 'T', '--space', 'ops'], piped)).toEqual([['task', 'add', 'T', '--space', 'ops'], 'from stdin'])
  await expect(taskStdin(['task', 'add', 'T', '--brief'], none)).rejects.toThrow('Give --brief TEXT')
})
