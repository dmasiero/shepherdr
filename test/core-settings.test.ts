import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreStore } from '../server/core/store.ts'
import { CoreSettings } from '../server/core/settings.ts'
import type { CoreFiles } from '../server/core/files.ts'
import type { CoreSpace } from '../server/core/model.ts'

function fixture(run: (settings: CoreSettings) => void) {
  const home = mkdtempSync(join(tmpdir(), 'shep-settings-')), store = new CoreStore(home)
  const spaces = [{ id: 'p:box:one', machine: 'box', name: 'one' }, { id: 'p:box:two', machine: 'box', name: 'two' }, { id: 'p:other:one', machine: 'other', name: 'one' }] as CoreSpace[]
  try { run(new CoreSettings(store, {} as CoreFiles, () => spaces, id => id, () => {})) }
  finally { store.close(); rmSync(home, { recursive: true, force: true }) }
}

test('settings follow stable machine and space identities, including an explicit empty private override', () => fixture(settings => {
  settings.set('task.instructions', 'Everywhere rule')
  settings.set('task.instructions', 'Machine rule', 'm:box')
  settings.set('task.instructions', '', 'p:box:one')
  expect(settings.get('task.instructions', 'p:box:one')).toBe('')
  expect(settings.get('task.instructions', 'p:box:two')).toBe('Machine rule')
  expect(settings.get('task.instructions', 'p:other:one')).toBe('Everywhere rule')
  settings.set('task.instructions', null, 'p:box:one')
  expect(settings.get('task.instructions', 'p:box:one')).toBe('Machine rule')
  expect(settings.sections().find(section => section.level === 'p:box:two' && section.name === 'Private instructions')?.rows[1]).toMatchObject({ value: 'Machine rule', from: 'box' })
}))

test('restart defaults save only the chosen role and scope; invalid changes roll back atomically', () => fixture(settings => {
  settings.saveAgent('task', 'p:box:one', { kind: 'codex', model: 'gpt-6.1-sol', effort: 'high' })
  expect(settings.agent('task', 'p:box:one')).toEqual({ kind: 'codex', model: 'gpt-6.1-sol', effort: 'high' })
  expect(settings.launch('task', 'p:box:one', 'claude')).toEqual({ kind: 'claude', model: undefined, effort: undefined })
  expect(settings.agent('coordinator', 'p:box:one').kind).toBe('claude')
  expect(settings.agent('task', 'p:box:two').kind).toBe('claude')
  expect(() => settings.saveAgent('task', 'p:box:one', { kind: 'claude', model: 'other', effort: 'nonsense' })).toThrow()
  expect(settings.agent('task', 'p:box:one').kind).toBe('codex')
}))

test('private rules are role-scoped and excluded from ordinary command output', () => fixture(settings => {
  settings.set('reviewer.instructions', 'Private reviewer rule', 'p:box:one')
  expect(settings.instructions('reviewer', 'p:box:one')).toContain('Private reviewer rule')
  expect(settings.instructions('task', 'p:box:one')).not.toContain('Private reviewer rule')
  expect(settings.describe('p:box:one')).not.toContain('Private reviewer rule')
  expect(() => settings.set('review.rounds', '11 rounds')).toThrow()
  expect(() => settings.set('not.a.setting', 'value')).toThrow()
  expect(() => settings.set('task.agent', 'pi')).toThrow()
}))


test('a changed CLI never inherits a foreign model, including from another scope', () => fixture(settings => {
  settings.set('task.agent', 'Codex')
  settings.set('task.model', 'gpt-6.1-sol')
  settings.set('task.agent', 'Claude Code', 'm:box')
  expect(settings.agent('task', 'p:box:one')).toMatchObject({ kind: 'claude', model: undefined })
  expect(settings.sections().find(section => section.level === 'p:box:one' && section.name === 'Agents')?.rows.find(row => row.key === 'task.model')?.warn).toBeTruthy()
  settings.set('task.agent', 'Claude Code')
  expect(settings.agent('task', 'p:other:one').model).toBeUndefined()
  expect(() => settings.set('task.model', 'gpt-6.1-sol')).toThrow('model offered')
}))


test('browser idle settings keep minute units, bounds and off across scopes', () => fixture(settings => {
  settings.set('browser.idleClose', '1 min', 'p:box:one')
  expect(settings.get('browser.idleClose', 'p:box:one')).toBe('1 min')
  settings.set('browser.idleClose', 'off', 'm:box')
  expect(settings.get('browser.idleClose', 'p:box:two')).toBe('off')
  expect(settings.get('browser.idleClose', 'p:other:one')).toBe('10 min')
  expect(() => settings.set('browser.idleClose', '0 min')).toThrow()
  expect(() => settings.set('browser.idleClose', '1441 min')).toThrow()
  expect(() => settings.set('browser.idleClose', '2 rounds')).toThrow()
  settings.set('review.rounds', '1 round')
  expect(settings.get('review.rounds')).toBe('1 round')
}))
