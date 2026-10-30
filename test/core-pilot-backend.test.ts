import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pilotCoreBackend } from '../helper/core-pilot-backend.ts'
import { pilotHook } from '../server/core/pilot-hook.ts'
import type { MailCredential } from '../server/core/envelope.ts'

test('contained backend fixes its endpoint credential and cwd outside caller input', async () => {
  const credential = { version: 1, server: 'server', grant: 'grant', machine: 'machine', key: 'private' } satisfies MailCredential
  const calls: unknown[][] = [], endpoint = { binary: '/private/hc', socket: '/private/core.sock' }, signal = new AbortController().signal
  const backend = pilotCoreBackend(endpoint, credential, '/own/worktree', async (...args) => { calls.push(args); return { allow: false } })
  const id = randomUUID()
  await backend.cli(['show'], undefined, id, signal)
  await backend.cli(['heartbeat', 'set'], 'list', randomUUID(), signal)
  await backend.secret(['KEY'], randomUUID(), signal)
  await backend.hook({ hook_event_name: 'Stop', chat: 'forged', cwd: '/other' }, randomUUID(), signal)
  await backend.lease(signal); await backend.reserve(42, signal); await backend.reserve(42, signal)
  for (const call of calls) { expect(call[0]).toBe(endpoint); expect(call[1]).toBe(credential); expect((call[4] as { signal: AbortSignal }).signal).toBe(signal) }
  expect(calls[0]!.slice(2, 4)).toEqual(['cli', { args: ['show'], cwd: '/own/worktree' }])
  expect(calls[1]![3]).toEqual({ args: ['heartbeat', 'set'], cwd: '/own/worktree', stdin: 'list' })
  expect(calls[2]![3]).toEqual({ names: ['KEY'] })
  expect(calls[3]![2]).toBe('pilot')
  expect(calls[4]![3]).toEqual({ op: 'lease' })
  expect(calls[5]![3]).toEqual({ op: 'traffic', bytes: 42 })
  expect((calls[5]![4] as { id: string }).id).not.toBe((calls[6]![4] as { id: string }).id)
})

test('contained hook mapping accepts only the chosen provider tree and strips caller authority', () => {
  const id = randomUUID(), input = { hook_event_name: 'SessionStart', transcript_path: '/home/agent/.claude/projects/repo/session.jsonl', session_id: 'native', chat: 'other', grant: 'forged' }
  const event = pilotHook(input, id, 'claude', '/home/agent', '/private/captures', 100)
  expect(event).toEqual({ id, event: 'SessionStart', at: 100, session: 'native', transcript: '/private/captures/.claude/projects/repo/session.jsonl', agent: undefined, model: undefined, tool: undefined })
  expect(pilotHook({ hook_event_name: 'Stop' }, id, 'codex', '/home/agent', '/private/captures', 101).transcript).toBeUndefined()
  for (const path of ['/etc/secret.jsonl', '/home/agent-other/.claude/projects/x.jsonl', '/home/agent/.claude/projects/../../secret.jsonl', '/home/agent/.claude/projects//x.jsonl', '/home/agent/.codex/sessions/x.jsonl', '/home/agent/.claude/projects/x.jsonl\n']) expect(() => pilotHook({ ...input, transcript_path: path }, id, 'claude', '/home/agent', '/private/captures')).toThrow()
  expect(() => pilotHook({ hook_event_name: 'Unknown' }, id, 'claude', '/home/agent', '/private/captures')).toThrow()
})
