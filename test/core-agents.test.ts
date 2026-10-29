import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreAgents } from '../server/core/agents.ts'
import { CoreStore } from '../server/core/store.ts'
import type { CoreAgent } from '../server/core/model.ts'
import type { CoreSession } from '../server/core/session.ts'
import type { Mailbox } from '../server/core/mailbox.ts'

test('late hooks cannot overwrite a replacement agent or erase its confirmed terminal', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-race-'))
  const store = new CoreStore(home)
  try {
    const agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, {} as CoreSession, store, {} as Mailbox, async () => undefined, () => {})
    const first: CoreAgent = { chat: 'chat', space: 'space', machine: 'machine', role: 'coordinator', kind: 'claude', launch: 'launch-one', grant: 'grant-one', hook: '/one', started: 1, state: 'starting' }
    store.set('agent', 'chat', first)
    // A hook file read began before terminal.run confirmed the terminal.
    store.set('agent', 'chat', { ...first, terminal: 't1' })
    agents.hook(first, { id: 'event-one', event: 'SessionStart', at: 2, session: 'native-one' })
    expect(agents.get('chat')).toMatchObject({ terminal: 't1', session: 'native-one', state: 'idle' })
    const replacement: CoreAgent = { ...first, kind: 'codex', launch: 'launch-two', grant: 'grant-two', terminal: 't2', hook: '/two', state: 'working' }
    store.set('agent', 'chat', replacement)
    agents.hook(first, { id: 'event-late', event: 'SessionEnd', at: 3, session: 'old-native' })
    expect(agents.get('chat')).toEqual(replacement)
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('terminal confirmation preserves hooks received while terminal.run was pending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-agent-start-'))
  const store = new CoreStore(home)
  try {
    let agents: CoreAgents
    const core = { call: async () => {
      const record = agents.get('chat')!
      agents.hook(record, { id: 'fast-hook', event: 'SessionStart', at: Date.now(), session: 'native-session', transcript: '/native.jsonl' })
      return { address: 't1', pid: 123 }
    } } as unknown as CoreSession
    const mailbox = { issue: () => ({ id: 'grant', credential: { version: 1, grant: 'grant', server: 'server', machine: 'machine', key: '' } }) } as unknown as Mailbox
    agents = new CoreAgents({ home, port: 17887, session: 'test', socket: '/unused', binary: 'hc' },
      { format: 'shepherdr-core', schema: 1, id: 'installation' }, core, store, mailbox, async () => undefined, () => {})
    const result = await agents.launch({ id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular', added: 1 }, 'chat', 'codex', 'hello')
    expect(result).toMatchObject({ terminal: 't1', pid: 123, state: 'idle', session: 'native-session', transcript: '/native.jsonl' })
    agents.hook(result, { id: 'answered-permission', event: 'PermissionRequest', at: Date.now() })
    expect(agents.get('chat')?.permission).toBeUndefined()
  } finally { store.close(); rmSync(home, { recursive: true, force: true }) }
})
