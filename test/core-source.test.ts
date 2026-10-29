import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreSource } from '../server/core/source.ts'

test('a dropping remote cannot block local startup snapshot or refresh', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-source-'))
  const source = new CoreSource({ home, port: 17887, socket: '/unused', session: 'test', binary: 'hc' })
  let finish!: (bytes: Buffer<ArrayBuffer>) => void
  try {
    source.core.call = async <T>(method: string) => (method === 'server.status' ? { core: { id: 'local', name: 'local' } }
      : { machines: [{ id: 'remote', name: 'box', state: 'connected' }] }) as T
    source.store.set('space', 'p:local:~', { id: 'p:local:~', name: '~', home: true, machine: 'local', folder: '/unused', base: 'main', prefix: 'TASK', mode: 'regular', added: 1 })
    source.files.exec = () => new Promise<Buffer<ArrayBuffer>>(resolve => { finish = resolve })
    // Resolves while the remote exec is still pending, rather than holding startup hostage.
    await source.refresh()
    expect(source.snapshot().places.some(place => place.id === 'p:local:~')).toBe(true)
    let failed = false
    source.files.exec = async () => { failed = true; throw new Error('remote dropped') }
    finish(Buffer.from('/remote/home')); await Bun.sleep(0)
    source.store.delete('space', 'p:remote:~')
    await source.refresh(); await Bun.sleep(0)
    expect(failed).toBe(true)
    expect(source.snapshot().places.some(place => place.id === 'p:remote:~')).toBe(false)
    expect(source.snapshot().places.some(place => place.id === 'p:local:~')).toBe(true)
  } finally { source.stop(); await Promise.resolve(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
})
