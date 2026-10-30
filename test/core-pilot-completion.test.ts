import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreSource } from '../server/core/source.ts'
import { CorePilotCompletion } from '../server/core/pilot-completion.ts'
import type { CoreAgent } from '../server/core/model.ts'

async function fixture(work: (f: ReturnType<typeof setup>) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'shep-complete-')), source = new CoreSource({ home, port: 17899, socket: '/unused', session: 'test', binary: 'hc' })
  try { await work(setup(source)) } finally { source.stop(); await Bun.sleep(0); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
}
function setup(source: CoreSource) {
  const space = { id: 'p:machine:demo', name: 'demo', folder: '/repo', machine: 'machine', base: 'main', prefix: 'DEMO', mode: 'autopilot', added: Date.now() }
  source.store.set('space', space.id, space)
  const run = source.pilots.policy.begin(space.id, space.machine, source.settings.pilot(space.id))
  const agent: CoreAgent = { chat: space.id, space: space.id, machine: space.machine, kind: 'claude', role: 'coordinator', grant: 'grant', launch: 'launch', hook: '/unused', state: 'idle', started: Date.now(), pilot: { run: run.id, home: '/inside', captures: '/private' } }
  source.store.set('agent', agent.chat, agent); source.pilots.policy.activate(run.id, { chat: agent.chat, launch: agent.launch, role: 'coordinator' })
  source.machineConnected = () => true
  source.agents.terminal = (() => ({ state: 'live' })) as unknown as typeof source.agents.terminal
  let starts = 0
  source.pilots.lifecycle.regular = async () => {
    starts++
    source.store.set('agent', agent.chat, { ...agent, launch: 'regular', started: Date.now(), pilot: undefined })
    space.mode = 'regular'; source.store.set('space', space.id, space)
  }
  return { source, space, run, agent, starts: () => starts }
}
test('completion stores evidence and revokes before effects, then launches regular only once across reconstruction', () => fixture(async f => {
  expect(f.source.pilots.completion.request(f.agent, 'Exact goal evidence')).toContain('saved')
  expect(f.starts()).toBe(0)
  expect(f.source.store.get('pilot-progress', f.run.id)).toMatchObject({ text: 'Exact goal evidence' })
  expect(f.source.pilots.policy.get(f.run.id)?.state).toBe('stopping')
  expect(() => f.source.pilots.policy.actor(f.run.id, f.source.pilots.actor(f.agent))).toThrow()
  await new CorePilotCompletion(f.source).tick()
  await new CorePilotCompletion(f.source).tick()
  expect(f.starts()).toBe(1)
  expect(f.source.store.get('pilot-completion', f.run.id)).toMatchObject({ state: 'done', evidence: 'Exact goal evidence' })
}))
test('completion cannot borrow labels or worker identity and cannot stop a newer run', () => fixture(async f => {
  expect(() => f.source.pilots.completion.request({ ...f.agent, role: 'task' }, 'No')).toThrow('coordinator')
  expect(() => f.source.pilots.completion.request({ ...f.agent, launch: 'forged' }, 'No')).toThrow('belong')
  f.source.pilots.completion.request(f.agent, 'Old evidence')
  f.source.pilots.policy.stopped(f.run.id)
  const next = f.source.pilots.policy.begin(f.space.id, f.space.machine, f.run.config)
  f.source.pilots.policy.activate(next.id, { chat: f.agent.chat, launch: 'new-pilot', role: 'coordinator' })
  await f.source.pilots.completion.tick()
  expect(f.starts()).toBe(0)
  expect(f.source.pilots.policy.get(next.id)?.state).toBe('on')
  expect(f.source.store.get('pilot-completion', f.run.id)).toMatchObject({ state: 'uncertain', error: expect.stringContaining('newer run') })
}))
test('an unconfirmed regular start after a crash is surfaced rather than launched twice', () => fixture(async f => {
  f.source.pilots.completion.request(f.agent, 'Saved evidence')
  const intent = f.source.store.get<Record<string, unknown>>('pilot-completion', f.run.id)!
  f.source.store.set('pilot-completion', f.run.id, { ...intent, state: 'changing' })
  f.source.store.set('agent', f.agent.chat, { ...f.agent, launch: 'unconfirmed', started: Number(intent.at), pilot: undefined })
  f.source.agents.terminal = () => undefined
  await new CorePilotCompletion(f.source).tick()
  expect(f.starts()).toBe(0)
  expect(f.source.store.get('pilot-completion', f.run.id)).toMatchObject({ state: 'uncertain', error: expect.stringContaining('unconfirmed') })
}))

test('old completion cannot stop a newer retained-worker run after interrupted mode-off', () => fixture(async f => {
  f.source.pilots.completion.request(f.agent, 'Old goal')
  f.source.pilots.policy.stopped(f.run.id)
  const next = f.source.pilots.policy.begin(f.space.id, f.space.machine, f.run.config)
  f.source.pilots.policy.activate(next.id, { chat: f.agent.chat, launch: 'next', role: 'coordinator' })
  f.source.pilots.policy.stop(next.id, true)
  f.source.store.set('agent', f.agent.chat, { ...f.agent, launch: 'next', pilot: { ...f.agent.pilot, run: next.id } })
  f.space.mode = 'regular'; f.source.store.set('space', f.space.id, f.space)
  expect(f.source.pilots.policy.current(f.space.id)).toBeUndefined()
  await new CorePilotCompletion(f.source).tick()
  expect(f.starts()).toBe(0)
  expect(f.source.pilots.policy.get(next.id)?.state).toBe('workers')
  expect(f.source.store.get('pilot-completion', f.run.id)).toMatchObject({ state: 'uncertain', error: expect.stringContaining('newer run') })
}))
