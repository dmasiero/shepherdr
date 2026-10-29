import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreLogs } from '../server/core/logs.ts'
import { CoreStore } from '../server/core/store.ts'
import { CoreError } from '../server/core/client.ts'
import type { CoreAgents } from '../server/core/agents.ts'
import type { CoreFiles } from '../server/core/files.ts'

// Same EOF rule as pinned core: offset N+1 is invalid, including a stable hooks file.
test('stable hooks at EOF do not block subsequent native transcript lines', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-eof-')), store = new CoreStore(home)
  const agent = { chat: 'chat', machine: 'machine', launch: 'one', grant: 'grant', kind: 'codex', hook: '/hooks', transcript: '/native', state: 'idle' }
  const assistant = (text: string) => JSON.stringify({ timestamp: '2026-10-29T12:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n'
  const content: Record<string, string> = { '/hooks': JSON.stringify({ id: 'hook', event: 'SessionStart', at: 1 }) + '\n', '/native': assistant('first') }
  const faults: string[] = []
  const files = { text: async (_machine: string, path: string, first: number, limit: number) => {
    const lines = content[path].match(/[^\n]*\n|[^\n]+$/g) ?? []
    if (first > lines.length && first > 1) throw new CoreError('invalid_params', `offset ${first}: the file has ${lines.length} lines`)
    const given = lines.slice(first - 1, first - 1 + limit)
    return { text: given.join(''), first, last: first + given.length - 1, lines: lines.length }
  } } as unknown as CoreFiles
  const agents = { all: () => [agent], get: () => agent, hook: () => {} } as unknown as CoreAgents
  const logs = new CoreLogs(agents, files, store, () => {}, (_chat, fault) => faults.push(fault))
  try {
    await logs.poll(); content['/native'] += assistant('second'); await logs.poll(); await logs.poll()
    expect(logs.messages('chat').map(message => message.text)).toEqual(['first', 'second'])
    expect(faults).toEqual([])
    content['/native'] = assistant('replacement'); await logs.poll()
    expect(logs.messages('chat').some(message => message.text === 'replacement')).toBe(true)
  } finally { logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})
