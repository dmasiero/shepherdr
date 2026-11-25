// fork: the keyboard's echo of a sent message (echo.ts)
import { expect, test } from 'bun:test'
import { ECHO_MS, isEcho, sentFrom } from './echo.ts'

const sent = "It looks like there's a bug. I've attached a short video"

test("the keyboard writing the whole sent message back into the emptied box is dropped (Gboard's voice typing)", () => {
  sentFrom('a', sent, 1000)
  expect(isEcho('a', '', sent, sent, 1300)).toBe(true)
  // its commit after its composition: dropped too
  expect(isEcho('a', '', sent, sent, 1400)).toBe(true)
})

test('the last word the keyboard still held, written back, is dropped', () => {
  sentFrom('b', sent, 1000)
  expect(isEcho('b', '', 'video', 'video', 1200)).toBe(true)
})

test('what is typed after a send stays, and ends the watch', () => {
  sentFrom('c', sent, 1000)
  expect(isEcho('c', '', 'v', 'v', 1100)).toBe(false)
  expect(isEcho('c', 'v', 'video', 'ideo', 1200)).toBe(false)
  expect(isEcho('c', '', 'video', 'video', 1300)).toBe(false)
})

test('a new message, or the same words long after, stays', () => {
  sentFrom('d', sent, 1000)
  expect(isEcho('d', '', 'Thanks', 'Thanks', 1200)).toBe(false)
  sentFrom('e', sent, 1000)
  expect(isEcho('e', '', sent, sent, 1000 + ECHO_MS + 1)).toBe(false)
  expect(isEcho('f', '', sent, sent, 1000)).toBe(false)
})

test('part of a word is no echo', () => {
  sentFrom('g', sent, 1000)
  expect(isEcho('g', '', 'deo', 'deo', 1200)).toBe(false)
})
