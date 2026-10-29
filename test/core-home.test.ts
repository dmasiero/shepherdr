import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectHome, prepareHome, readCredential } from '../server/core/home.ts'
import { CoreStore } from '../server/core/store.ts'

test('legacy home is classified without writes and startup refuses to reuse it', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-legacy-'))
  try {
    const original = '{"legacy":true}\n'
    writeFileSync(join(home, 'tasks.json'), original)
    expect(inspectHome(home)).toBe('legacy')
    expect(() => prepareHome(home)).toThrow('legacy state')
    expect(readFileSync(join(home, 'tasks.json'), 'utf8')).toBe(original)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('fresh core home has stable identity and cannot be a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-home-'))
  try {
    const first = prepareHome(join(root, 'fresh'))
    expect(prepareHome(join(root, 'fresh'))).toEqual(first)
    symlinkSync(join(root, 'fresh'), join(root, 'link'))
    expect(() => prepareHome(join(root, 'link'))).toThrow('real directory')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('credential must be a private owned regular file, not a symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-credential-'))
  try {
    writeFileSync(join(root, 'good'), '{"example":true}', { mode: 0o600 })
    writeFileSync(join(root, 'public'), '{}', { mode: 0o644 })
    symlinkSync(join(root, 'good'), join(root, 'link'))
    expect(readCredential(join(root, 'good'))).toEqual({ example: true })
    expect(() => readCredential(join(root, 'public'))).toThrow('private file')
    expect(() => readCredential(join(root, 'link'))).toThrow('private file')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('browser command idempotency persists outcomes across restart and rejects changed inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shep-command-'))
  const home = join(root, 'state')
  let store = new CoreStore(home), effects = 0
  try {
    const command = async () => ({ result: ++effects })
    expect(await store.command('command-123', { type: 'send', text: 'hello' }, command)).toEqual({ result: 1 })
    store.close(); store = new CoreStore(home)
    expect(await store.command('command-123', { type: 'send', text: 'hello' }, command)).toEqual({ result: 1 })
    await expect(store.command('command-123', { type: 'send', text: 'different' }, command)).rejects.toMatchObject({ kind: 'conflict' })
    expect(effects).toBe(1)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
