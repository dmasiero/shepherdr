import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStore } from '../server/core/store.ts'
import { CoreAutomations } from '../server/core/automations.ts'
import type { CoreSource } from '../server/core/source.ts'
import type { CoreSpace } from '../server/core/model.ts'
import type { CoreTask } from '../server/core/tasks.ts'

async function fixture(run: (context: { source: CoreSource; scheduler: CoreAutomations; launches: string[]; tasks: CoreTask[]; space: CoreSpace }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'shep-automation-')), store = new CoreStore(home)
  const spaces = [{ id: 'p:box:demo', name: 'demo', machine: 'box', folder: '/repo', prefix: 'DEMO', base: 'main' }, { id: 'p:other:demo', name: 'demo', machine: 'other', folder: '/other', prefix: 'DEMO', base: 'main' }] as CoreSpace[]
  const tasks: CoreTask[] = [], launches: string[] = []
  const source = { store, connected: () => true, emit() {}, on() {}, settings: { get: () => 'UTC' }, spaces: () => spaces, space: (id: string) => spaces.find(space => space.id === id), tasks: {
    all: () => tasks, view: (task: CoreTask) => ({ status: task.status }),
    addInSpace: async (space: CoreSpace, input: { title: string; automation: string }) => { launches.push(space.id); const task = { id: `DEMO-${launches.length}`, place: space.id, name: input.title, workflow: 'working', status: 'work', automation: input.automation } as CoreTask; tasks.push(task); return task },
  } } as unknown as CoreSource
  const scheduler = new CoreAutomations(source)
  try { await run({ source, scheduler, launches, tasks, space: spaces[0] }) }
  finally { scheduler.stop(); await scheduler.drain(); store.close(); rmSync(home, { recursive: true, force: true }) }
}

test('due once rule claims before launch, runs once and keeps its task/run across restart', async () => fixture(async ({ source, scheduler, launches, space }) => {
  scheduler.model.add({ place: space.id, name: 'daily', trigger: { time: 'once 2020-01-01 00:00' }, task: { title: 'Check' } }, 0)
  await scheduler.scan(); await scheduler.drain()
  expect(launches).toEqual([space.id])
  expect(scheduler.model.find(space.id, 'daily')).toMatchObject({ on: false, runs: [{ task: 'DEMO-1' }] })
  const restarted = new CoreAutomations(source)
  try { await restarted.scan(); await restarted.drain(); expect(launches).toHaveLength(1) }
  finally { restarted.stop() }
}))

test('lost manual response reuses durable command and paused automation stays paused after run now', async () => fixture(async ({ scheduler, launches, space }) => {
  scheduler.model.add({ place: space.id, name: 'manual', trigger: { on: [{ event: 'ready' }] }, task: { title: 'Check' } })
  scheduler.model.pause(space.id, 'manual', false)
  const action = { type: 'automation' as const, cid: 'manual-run-retry', place: space.id, name: 'manual', op: 'run' as const }
  expect(await scheduler.act(action)).toEqual({ task: 'DEMO-1' })
  expect(await scheduler.act(action)).toEqual({ task: 'DEMO-1' })
  expect(launches).toHaveLength(1)
  expect(scheduler.model.find(space.id, 'manual')?.on).toBe(false)
}))

test('events distinguish identical space names on other machines and suppress automation-added recursion', async () => fixture(async ({ scheduler, launches, tasks, space }) => {
  scheduler.model.add({ place: space.id, name: 'added', trigger: { on: [{ event: 'added' }] }, task: { title: 'Check' } })
  await scheduler.event({ event: 'added', space: 'demo' }, 'p:other:demo'); await scheduler.drain()
  expect(launches).toHaveLength(0)
  tasks.push({ id: 'DEMO-human', name: 'Human', place: space.id, workflow: 'working', status: 'work' } as CoreTask)
  await scheduler.scan(); await scheduler.drain(); await scheduler.scan(); await scheduler.drain()
  expect(launches).toHaveLength(1)
  expect(tasks).toHaveLength(2)
}))

test('restart settles an interrupted claim without launching twice and shutdown refuses new runs', async () => fixture(async ({ source, scheduler, launches, space }) => {
  const automation = scheduler.model.add({ place: space.id, name: 'interrupted', trigger: { on: [{ event: 'ready' }] }, task: { title: 'Check' } })
  const run = { id: 'interrupted-run', automation: automation.id, place: space.id, at: Date.now(), timed: false, state: 'starting' }
  scheduler.model.fired(automation, { error: 'Starting' }, run.at)
  source.store.set('automation-run', run.id, run)
  scheduler.start(); await scheduler.drain()
  expect(scheduler.model.find(space.id, 'interrupted')?.runs?.[0]?.error).toContain('interrupted')
  expect(launches).toHaveLength(0)
  source.quiescing = true
  await expect(scheduler.fire(automation)).rejects.toThrow('stopping')
}))


test('two matching events in one scan each keep a durable run while one automation is busy', async () => fixture(async ({ source, scheduler, launches, tasks, space }) => {
  scheduler.model.add({ place: space.id, name: 'ready', trigger: { on: [{ event: 'ready' }] }, task: { title: 'Check each' } })
  const first = { id: 'HUMAN-1', name: 'First', place: space.id, workflow: 'working', status: 'work' } as CoreTask
  const second = { ...first, id: 'HUMAN-2', name: 'Second' }
  tasks.push(first, second)
  await scheduler.scan(); await scheduler.drain()
  first.workflow = second.workflow = 'ready'
  first.status = second.status = 'ready'
  await scheduler.scan(); await scheduler.drain()
  expect(launches).toHaveLength(2)
  expect(source.store.all<{ state: string }>('automation-run').filter(run => run.state === 'done')).toHaveLength(2)
  await scheduler.scan(); await scheduler.drain()
  expect(launches).toHaveLength(2)
}))


test('an unrelated explicit event rule cannot grant another machine implicit-space authority', async () => fixture(async ({ scheduler, launches, space }) => {
  scheduler.model.add({ place: space.id, name: 'mixed', trigger: { on: [{ event: 'ready' }, { event: 'merged', space: 'other' }] }, task: { title: 'Check' } })
  await scheduler.event({ event: 'ready', space: 'demo' }, 'p:other:demo'); await scheduler.drain()
  expect(launches).toHaveLength(0)
  await scheduler.event({ event: 'ready', space: 'demo' }, space.id); await scheduler.drain()
  expect(launches).toHaveLength(1)
}))

test('invalid schedule returns a useful refusal before creating an automation', async () => fixture(async ({ scheduler, space }) => {
  const agent = { role: 'coordinator', machine: space.machine, space: space.id } as Parameters<CoreAutomations['cli']>[0]
  await expect(scheduler.cli(agent, ['automation', 'add', 'Check', '--task', 'Check', '--when', 'every 5 minutes'])).rejects.toThrow('RRULE')
  expect(scheduler.model.list).toHaveLength(0)
  await expect(scheduler.cli({ ...agent, role: 'task' }, ['automation', 'list'])).rejects.toThrow('Only a coordinator')
}))
