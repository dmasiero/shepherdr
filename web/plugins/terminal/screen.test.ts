import { expect, test } from 'bun:test'
import { atEnd, toEnd } from './screen.ts'

test('a box at its end follows the newest line; one scrolled back to read does not', () => {
  expect(atEnd({ scrollHeight: 1000, scrollTop: 696, clientHeight: 304 })).toBe(true)
  expect(atEnd({ scrollHeight: 1000, scrollTop: 694, clientHeight: 304 })).toBe(true)
  // SHEP-22: the keyboard came up and the box got shorter, its scroll left where it was: the prompt is under the keyboard
  expect(atEnd({ scrollHeight: 1000, scrollTop: 696, clientHeight: 40 })).toBe(false)
  expect(atEnd({ scrollHeight: 1000, scrollTop: 100, clientHeight: 304 })).toBe(false)
})

test("to the prompt: the terminal's history and the box around it both go to their end", () => {
  const box = { scrollHeight: 1000, scrollTop: 100 }
  let history = 0
  toEnd(box, { scrollToBottom: () => history++ })
  expect(box.scrollTop).toBe(1000)
  expect(history).toBe(1)
  // the terminal not drawn yet, or the box gone: what is there still goes
  toEnd(null, { scrollToBottom: () => history++ })
  expect(history).toBe(2)
  const alone = { scrollHeight: 500, scrollTop: 0 }
  toEnd(alone, null)
  expect(alone.scrollTop).toBe(500)
})
