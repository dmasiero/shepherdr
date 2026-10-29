import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CoreSource } from '../server/core/source.ts'
import type { CoreAgent, CoreSpace } from '../server/core/model.ts'
import type { Grant } from '../server/core/mailbox.ts'

test('answer and delivery are durable while offline, and stale cards cannot answer a replacement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-question-'))
  const source = new CoreSource({ home, port: 17887, socket: '/unused', session: 'test', binary: 'hc' })
  try {
    const agent: CoreAgent = { chat: 'space', space: 'space', machine: 'machine', role: 'coordinator', kind: 'codex', launch: 'launch-one', grant: 'grant-one', hook: '/unused', state: 'idle', started: Date.now() }
    source.store.set('agent', agent.chat, agent)
    source.store.set('space', 'space', { id: 'space', name: 'Example', machine: 'machine', folder: '/unused', base: 'main', prefix: 'EX', mode: 'regular', added: 1 } satisfies CoreSpace)
    const grant = { chat: agent.chat, id: agent.grant } as Grant
    const first = source.questions.create(grant, ['ask', 'Continue?', '--choice', 'Yes', '--choice', 'No'])
    await source.questions.answer({ type: 'answer', chat: agent.chat, question: first, choice: 0 })
    expect(source.questions.open()).toHaveLength(0)
    expect(source.store.get('pending-send', `answer-${first}`)).toMatchObject({ chat: agent.chat, launch: agent.launch, state: 'queued' })
    const second = source.questions.create(grant, ['ask', 'Approve?', '--choice', 'Yes'])
    source.store.set('agent', agent.chat, { ...agent, grant: 'grant-two', launch: 'launch-two' })
    await expect(source.questions.answer({ type: 'answer', chat: agent.chat, question: second, choice: 0 })).rejects.toThrow('replaced')
    expect(source.store.get('pending-send', `answer-${second}`)).toBeUndefined()
    expect(source.questions.open()).toHaveLength(1)
  } finally { source.stop(); await Promise.resolve(); source.mailbox.close(); source.store.close(); rmSync(home, { recursive: true, force: true }) }
})
