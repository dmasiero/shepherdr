import { expect, test } from 'bun:test'
import type { Message, Task } from '@shared/types.ts'
import { reviewAt } from './card-place.ts'

// fork: Ready card below new messages. A waiting Ready card follows the agent's newest word in the task's chat; once
// done it keeps its time; in a space's chat only the task's own rows move it, never the Assistant's.

const t = { id: 'HOME-3', name: 'Home manual: furnace page', place: 'p:personal', status: 'ready' } as unknown as Task
const msg = (id: string, who: 'you' | 'agent', at: number, more: Partial<Message> = {}): Message => ({ id, who, at, text: id, ...more })
const READY = 1000
const thread = [msg('done', 'agent', 900), msg('q', 'you', 1100), msg('answer', 'agent', 1200), msg('more', 'you', 1300)]

test('in its chat: after the newest agent message that came after ready, so it sorts last of them', () => {
  const at = reviewAt(t, READY, thread, true, false)!
  expect(at).toBeGreaterThan(1200)
  // the chat draws a card before the first message at or after its time: none of the agent's is
  const order = [...thread.map((m) => ({ id: m.id, at: m.at! })), { id: 'card', at }].sort((a, b) => a.at - b.at).map((r) => r.id)
  expect(order).toEqual(['done', 'q', 'answer', 'card', 'more'])
})

test('in its chat: your own message, one still on its way, or a question waiting do not push it down', () => {
  expect(reviewAt(t, READY, [msg('q', 'you', 1100)], true, false)).toBe(READY)
  expect(reviewAt(t, READY, [msg('typing', 'agent', 1100, { waiting: true })], true, false)).toBe(READY)
  expect(reviewAt(t, READY, [msg('ask', 'agent', 1100, { question: { id: 'q1' } as Message['question'] })], true, false)).toBe(READY)
})

test('done: it stays where it came up', () => {
  expect(reviewAt(t, READY, thread, true, true)).toBe(READY)
})

test("in a space's chat: the Assistant's messages leave it; the task's own later row moves it", () => {
  const space = [msg('a1', 'agent', 1100), msg('a2', 'agent', 1500)]
  expect(reviewAt(t, READY, space, false, false)).toBe(READY)
  const news = msg('n', 'agent', 1400, { news: { task: 'HOME-3', ref: 'HOME-3', mark: 'ready', what: 'ready', text: 'Ready again' } })
  expect(reviewAt(t, READY, [...space, news], false, false)).toBe(1401)
})
