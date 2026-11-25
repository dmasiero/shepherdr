import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import { uniqueKeys } from './unique.ts'

// Terminal view shows date labels: a chat across two sessions had two messages with one id, so two rows with one key;
// React left one behind on a redraw, and View as terminal showed a column of stray time lines instead of the terminal.

const row = (key: string, text: string) => createElement('div', { key, className: 'time' }, text)
const keys = (rows: unknown[]) => rows.map((r) => (isValidElement(r) ? r.key : null))

test('every repeat of a key gets its own, the first keeps its own', () => {
  const out = uniqueKeys([row('t:a1', 'Friday 14:12'), row('a1', 'hi'), row('t:a1', 'Monday 11:02'), row('a1', 'again'), row('t:a1', 'Yesterday 16:08')])
  expect(keys(out)).toEqual(['t:a1', 'a1', 't:a1~2', 'a1~2', 't:a1~3'])
  expect(new Set(keys(out)).size).toBe(out.length)
})

test('the rows are the same rows: same element, props and order; unique keys untouched', () => {
  const a = row('t:a1', 'Friday 14:12'), b = row('t:a1', 'Monday 11:02'), c = row('s5', 'sent')
  const out = uniqueKeys([a, b, c, null, 'text'])
  expect(out[0] === a).toBe(true)
  expect(out[2] === c).toBe(true)
  const twin = out[1] as ReactElement
  expect(twin.type).toBe('div')
  expect(twin.props).toEqual(b.props)
  expect(out.slice(3)).toEqual([null, 'text'])
})

test("the chat draws its rows through it (the fork's hook in client.tsx)", () => {
  const src = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
  expect(src).toContain('{uniqueKeys(out)}')
  expect(src).not.toMatch(/^\s*\{out\}\s*$/m)
})
