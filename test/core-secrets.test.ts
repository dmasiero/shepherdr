import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreSource } from '../server/core/source.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'

async function fixture(run: (source: CoreSource, agent: CoreAgent) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'shep-secrets-'))
  const source = new CoreSource({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' })
  const space = { id: 'p:machine:one', name: 'one', machine: 'machine', folder: '/unused', base: 'main', prefix: 'ONE', mode: 'regular', added: 1 } as CoreSpace
  const agent: CoreAgent = { chat: space.id, space: space.id, machine: space.machine, role: 'coordinator', kind: 'claude', launch: 'launch', grant: 'grant', hook: '/unused', started: 1, state: 'idle' }
  source.store.set('space', space.id, space); source.store.set('agent', agent.chat, agent)
  try { await run(source, agent) }
  finally { source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
}

test('secret use derives scope from the authenticated session, ignoring claimed levels', async () => fixture(async (source, agent) => {
  source.secrets.vault.set('all', 'KEY', 'everywhere-test-value')
  source.secrets.vault.set('p:machine:other', 'KEY', 'other-space-test-value')
  source.secrets.vault.set(agent.space, 'KEY', 'own-space-test-value')
  expect(source.secrets.use(agent, { names: ['KEY'], level: 'p:machine:other', chat: 'other' })).toEqual({ secrets: { KEY: 'own-space-test-value' } })
  expect(() => source.secrets.use({ ...agent, role: 'reviewer' }, { names: ['KEY'] })).toThrow('Reviewers')
  expect(JSON.stringify(source.snapshot())).not.toContain('own-space-test-value')
  expect(JSON.stringify(source.snapshot())).not.toContain('other-space-test-value')
}))

test('secret cards expire on replacement and save only names into chat and delivery records', async () => fixture(async (source, agent) => {
  await source.secrets.cli(agent, ['secret', 'ask', 'DEMO_KEY', '--why', 'Isolated acceptance'])
  const message = source.logs.messages(agent.chat).find(item => item.secret)!
  source.store.set('agent', agent.chat, { ...agent, grant: 'replacement' })
  await expect(source.secrets.act({ type: 'secret', level: agent.space, name: 'DEMO_KEY', value: 'synthetic-value-one', card: { chat: agent.chat, id: message.id } })).rejects.toThrow('expired session')
  expect(source.secrets.vault.has(agent.space, 'DEMO_KEY')).toBe(false)
  source.store.set('agent', agent.chat, agent)
  await source.secrets.act({ type: 'secret', level: agent.space, name: 'DEMO_KEY', value: 'synthetic-value-one', card: { chat: agent.chat, id: message.id } })
  expect(source.logs.messages(agent.chat).find(item => item.id === message.id)?.secret?.saved).toBe('one')
  const records = JSON.stringify(source.store.db.query('SELECT * FROM records').all())
  expect(records).not.toContain('synthetic-value-one')
  expect(records).toContain('DEMO_KEY')
}))

test('corrupt vault diagnostics never echo stored material', async () => fixture(async (source) => {
  const fs = await import('node:fs')
  fs.writeFileSync(join(source.config.home, 'vault.json'), 'DO_NOT_DISCLOSE invalid JSON', { mode: 0o600 })
  expect(() => source.secrets.vault.pick(['KEY'], ['all'])).toThrow('fix or move')
  try { source.secrets.vault.pick(['KEY'], ['all']) } catch (error) { expect(String(error)).not.toContain('DO_NOT_DISCLOSE') }
}))


test('an older helper receives the owning launch command path, never secret values', async () => fixture(async (source, agent) => {
  agent.command = '/private/current/helper/bin/shepherdr'
  source.store.set('agent', agent.chat, agent)
  source.secrets.vault.set(agent.space, 'DEMO', 'synthetic-value')
  await expect(source.secrets.cli(agent, ['secret', 'run', 'DEMO'])).rejects.toThrow('/private/current/helper/bin/shepherdr')
  try { await source.secrets.cli(agent, ['secret', 'run', 'DEMO']) } catch (error) { expect(String(error)).not.toContain('synthetic-value') }
}))
