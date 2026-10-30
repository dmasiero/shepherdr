import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreLogs } from '../server/core/logs.ts'
import { CoreStore } from '../server/core/store.ts'
import type { CoreAgents } from '../server/core/agents.ts'
import type { CoreFiles } from '../server/core/files.ts'

// A stable hooks file must not hold back appended native transcript records.
test('stable hooks at EOF do not block subsequent native transcript lines', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-eof-')), store = new CoreStore(home)
  const agent = { chat: 'chat', machine: 'machine', launch: 'one', grant: 'grant', kind: 'codex', hook: join(home, 'hooks'), transcript: join(home, 'native'), state: 'idle' }
  const assistant = (text: string) => JSON.stringify({ timestamp: '2026-10-29T12:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }) + '\n'
  writeFileSync(agent.hook, JSON.stringify({ id: 'hook', event: 'SessionStart', at: 1 }) + '\n')
  writeFileSync(agent.transcript, assistant('first'))
  const faults: string[] = []
  const files = { exec: async (_machine: string, argv: string[], _cwd: string, input: Uint8Array) => {
    const result = Bun.spawnSync(argv, { stdin: input })
    if (result.exitCode) throw Error(result.stderr.toString())
    return result.stdout
  } } as unknown as CoreFiles
  const agents = { all: () => [agent], get: () => agent, hook: () => {}, bun: async () => process.execPath } as unknown as CoreAgents
  const incoming: string[] = []
  const logs = new CoreLogs(agents, files, store, () => {}, (_chat, fault) => faults.push(fault), (_chat, message) => incoming.push(message.text || ''))
  try {
    await logs.poll(); appendFileSync(agent.transcript, assistant('second')); await logs.poll(); await logs.poll()
    expect(logs.messages('chat').map(message => message.text)).toEqual(['first', 'second'])
    expect(incoming).toEqual(['first', 'second'])
    const user = (text: string) => JSON.stringify({ timestamp: '2026-10-29T12:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'
    appendFileSync(agent.transcript, user('<queue>Wait for DEMO-2.</queue>') + user('<hc>t2 exited (exit 129). Read: hc read t2</hc>') + user('<github>Observed checks failed</github>') + user('<news>Observed task failure</news>') + user('My actual follow-up'))
    await logs.poll()
    expect(logs.messages('chat').filter(message => message.who === 'you').map(message => message.text)).toEqual(['My actual follow-up'])
    expect(faults).toEqual([])
    writeFileSync(agent.transcript, assistant('replacement')); await logs.poll()
    expect(logs.messages('chat').some(message => message.text === 'replacement')).toBe(true)
  } finally { logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('old native core notices stay hidden while actual human messages and agent explanations remain', () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-core-notice-')), store = new CoreStore(home)
  const logs = new CoreLogs({} as CoreAgents, {} as CoreFiles, store, () => {}, () => {})
  try {
    const text = '<hc>t2 exited (exit 129). Read: hc read t2</hc>'
    store.set('message:chat', 'native', { id: 'native', source: 'native', who: 'you', text, at: 1 })
    store.set('message:chat', 'human', { id: 'human', source: 'human-native', who: 'you', text, at: 2 })
    store.set('message:chat', 'agent', { id: 'agent', source: 'agent', who: 'agent', text: 'The child finished safely.', at: 3 })
    expect(logs.messages('chat').map(message => message.id)).toEqual(['human', 'agent'])
  } finally { logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('a stalled remote log does not block a local native transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-remote-')), store = new CoreStore(home)
  const local = { chat: 'local', machine: 'local', launch: 'one', grant: 'grant', kind: 'codex', hook: join(home, 'hooks'), transcript: join(home, 'native'), state: 'idle' }
  const remote = { ...local, chat: 'remote', machine: 'remote' }
  writeFileSync(local.hook, '')
  writeFileSync(local.transcript, JSON.stringify({ timestamp: '2026-10-29T12:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'LOCAL_CONTINUES' }] } }) + '\n')
  let release!: () => void, arrived!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const updated = new Promise<void>(resolve => { arrived = resolve })
  const files = { exec: async (machine: string, argv: string[], _cwd: string, input: Uint8Array) => {
    if (machine === 'remote') { await blocked; throw Error('remote disconnected') }
    const result = Bun.spawnSync(argv, { stdin: input })
    if (result.exitCode) throw Error(result.stderr.toString())
    return result.stdout
  } } as unknown as CoreFiles
  const agents = { all: () => [remote, local], get: (chat: string) => chat === 'local' ? local : remote, hook: () => {}, bun: async () => process.execPath } as unknown as CoreAgents
  const logs = new CoreLogs(agents, files, store, chat => { if (chat === 'local') arrived() }, () => {})
  const polling = logs.poll()
  try {
    await updated; await Bun.sleep(0)
    expect(logs.messages('local').map(message => message.text)).toEqual(['LOCAL_CONTINUES'])
    appendFileSync(local.transcript, JSON.stringify({ timestamp: '2026-10-29T12:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'LOCAL_SECOND' }] } }) + '\n')
    await logs.poll()
    expect(logs.messages('local').map(message => message.text)).toEqual(['LOCAL_CONTINUES', 'LOCAL_SECOND'])
  } finally { release(); await polling; logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('poll slots rotate so more than four chats on one machine all make progress', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-fair-')), store = new CoreStore(home)
  const agents = Array.from({ length: 6 }, (_, i) => ({ chat: `chat-${i}`, machine: 'same', launch: 'one', grant: 'grant', kind: 'codex', hook: join(home, `hooks-${i}`), transcript: join(home, `native-${i}`), state: 'idle' }))
  for (const agent of agents) {
    writeFileSync(agent.hook, '')
    writeFileSync(agent.transcript, JSON.stringify({ timestamp: '2026-10-29T12:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: agent.chat }] } }) + '\n')
  }
  const files = { exec: async (_machine: string, argv: string[], _cwd: string, input: Uint8Array) => {
    const result = Bun.spawnSync(argv, { stdin: input })
    if (result.exitCode) throw Error(result.stderr.toString())
    return result.stdout
  } } as unknown as CoreFiles
  const logs = new CoreLogs({ all: () => agents, get: (chat: string) => agents.find(agent => agent.chat === chat), hook: () => {}, bun: async () => process.execPath } as unknown as CoreAgents, files, store, () => {}, () => {})
  try {
    for (let i = 0; i < 6; i++) await logs.poll()
    for (const agent of agents) expect(logs.messages(agent.chat).map(message => message.text)).toEqual([agent.chat])
  } finally { logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})

test('completion cleanup requires its private command receipt and later captured native turn end, not Stop idle', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-log-cleanup-')), store = new CoreStore(home)
  const agent = { chat: 'TASK-1/Agent', machine: 'machine', launch: 'one', grant: 'grant', kind: 'claude', hook: join(home, 'hooks'), transcript: join(home, 'native'), state: 'idle' } as import('../server/core/model.ts').CoreAgent
  const row = (value: unknown) => JSON.stringify(value) + '\n'
  const user = (id: string) => row({ type: 'user', uuid: id, timestamp: '2026-10-29T12:00:00Z', message: { role: 'user', content: id } })
  const final = (id: string, text: string) => row({ type: 'assistant', timestamp: '2026-10-29T12:00:01Z', message: { id, role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } })
  writeFileSync(agent.hook, '')
  writeFileSync(agent.transcript!, user('earlier') + final('old', 'Earlier reply'))
  const files = { exec: async (_machine: string, argv: string[], _cwd: string, input: Uint8Array) => {
    const result = Bun.spawnSync(argv, { stdin: input }); if (result.exitCode) throw Error(result.stderr.toString()); return result.stdout
  } } as unknown as CoreFiles
  const agents = { all: () => [agent], get: () => agent, hook: () => { agent.state = 'idle' }, bun: async () => process.execPath } as unknown as CoreAgents
  store.set('task-cleanup-receipt', agent.chat, { launch: 'one', receipt: 'private-finish-token', seen: false, complete: false })
  let logs = new CoreLogs(agents, files, store, () => {}, () => {})
  try {
    appendFileSync(agent.hook, row({ id: 'stop', event: 'Stop', at: 1 }))
    await logs.poll()
    expect(agent.state).toBe('idle'); expect(logs.cleanupComplete(agent, 'private-finish-token')).toBe(false)
    appendFileSync(agent.transcript!, user('new') + row({ type: 'assistant', timestamp: '2026-10-29T12:00:02Z', message: { id: 'call', role: 'assistant', content: [{ type: 'tool_use', id: 'ready', name: 'Bash', input: { command: 'shepherdr ready TASK-1' } }] } }) +
      row({ type: 'user', uuid: 'result', timestamp: '2026-10-29T12:00:03Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ready', content: 'Done; private-finish-token' }] } }))
    await logs.poll(); expect(logs.cleanupComplete(agent, 'private-finish-token')).toBe(false)
    // Restart/re-read must not mistake an earlier historical end for the current completion.
    logs.stop(); logs = new CoreLogs(agents, files, store, () => {}, () => {})
    await logs.poll(); expect(logs.cleanupComplete(agent, 'private-finish-token')).toBe(false)
    appendFileSync(agent.transcript!, final('finished', 'FINAL_REPLY_CAPTURED_OK'))
    await logs.poll()
    expect(logs.messages(agent.chat).some(message => message.text === 'FINAL_REPLY_CAPTURED_OK')).toBe(true)
    expect(logs.cleanupComplete(agent, 'private-finish-token')).toBe(true)
    expect(logs.cleanupComplete({ ...agent, launch: 'replacement' }, 'private-finish-token')).toBe(false)
    expect(logs.cleanupComplete(agent, 'other-token')).toBe(false)
  } finally { logs.stop(); store.close(); rmSync(home, { recursive: true, force: true }) }
})
