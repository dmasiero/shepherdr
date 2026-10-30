import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreSource } from '../server/core/source.ts'
import type { Question } from '../shared/types.ts'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'core-card-display-'))
  const source = new CoreSource({ home, port: 17887, socket: '/unused', session: 'test', binary: 'hc' })
  source.store.set('space', 'space', { id: 'space', name: 'Example', machine: 'machine', folder: '/unused', prefix: 'EX', mode: 'regular', added: 1 })
  source.store.set('agent', 'EX-1/Agent', { chat: 'EX-1/Agent', space: 'space', machine: 'machine', role: 'task', kind: 'claude', launch: 'one', grant: 'current', state: 'idle', started: 1 })
  source.store.set('task', 'EX-1', { id: 'EX-1', chat: 'EX-1/Agent', place: 'space', machine: 'machine', name: 'Example', folder: '/unused', workflow: 'todo', review: { on: false }, age: 'now', created: new Date().toISOString(), kind: 'claude' })
  return { source, close() { source.stop(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) } }
}
const question: Question = { id: 'permission-one', title: 'Use tool?', kind: 'Question', choices: [{ label: 'Allow once' }, { label: 'Deny' }], to: 'EX-1/Agent' }
function post(source: CoreSource, at = 100) {
  source.post('EX-1/Agent', { id: 'permission-one', who: 'agent', question, at })
  source.forwardQuestion('EX-1/Agent', question)
}
test('expired and replaced permission copies close without changing history or granting authority', async () => {
  const f = fixture()
  try {
    post(f.source)
    const forwarded = f.source.chat('space')!.messages.find(message => message.card?.ask)!
    const at = forwarded.at
    // Already-settled canonical records can outlive an older open chat copy.
    f.source.store.set('permission', question.id, { id: question.id, chat: 'EX-1/Agent', grant: 'current', settled: true, allow: false, expires: 1, question: { ...question, sent: -1, said: 'Permission request expired' } })
    expect(f.source.chat('EX-1/Agent')!.messages[0].question?.sent).toBe(-1)
    const closed = f.source.chat('space')!.messages.find(message => message.card?.ask)!
    expect(closed.card!.ask!.open).toBe(false)
    expect(closed.card!.ask!.questions![0].said).toBe('Permission request expired')
    expect(closed.at).toBe(at)
    await expect(f.source.act({ type: 'answer', chat: 'EX-1/Agent', question: question.id, choice: 0 })).rejects.toThrow('no longer waiting')
    expect(f.source.store.get<{ allow: boolean }>('permission', question.id)?.allow).toBe(false)
    // An unexpired request from another launch closes too, even before a stored copy is reconciled.
    f.source.store.set('permission', question.id, { id: question.id, chat: 'EX-1/Agent', grant: 'previous', expires: Date.now() + 60000, question })
    expect(f.source.chat('space')!.messages.find(message => message.card?.ask)!.card!.ask!.questions![0].said).toContain('Session replaced')
  } finally { f.close() }
})
test('permission expiry refreshes both chats and keeps its authority denied', async () => {
  const f = fixture()
  try {
    post(f.source)
    f.source.store.set('permission', question.id, { id: question.id, chat: 'EX-1/Agent', grant: 'current', expires: Date.now() - 1, question })
    // A normal chat update reconciles pending permission ownership/expiry.
    f.source.post('EX-1/Agent', { id: 'new', who: 'agent', text: 'continued', at: 200 })
    expect(f.source.store.get<{ settled: boolean; allow: boolean }>('permission', question.id)).toMatchObject({ settled: true, allow: false })
    const forwarded = f.source.chat('space')!.messages.find(message => message.card?.ask)!
    expect(forwarded.card!.text).toBe('No longer waiting')
    expect(forwarded.card!.ask!.questions![0].sent).toBe(-1)
    expect(f.source.snapshot().asks['EX-1/Agent']).toBeUndefined()
  } finally { f.close() }
})
