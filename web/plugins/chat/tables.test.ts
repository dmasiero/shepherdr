// A wide markdown table in a chat stays readable on a phone: its cells break only between words (the bubble's
// overflow-wrap:anywhere squeezed each column of a 9-column table to a letter), a cell of a few words keeps a
// minimum width, and the table scrolls sideways in its own box.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as M from './markdown.tsx'

const css = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rule = (sel: string) => css.split('}').filter((r) => r.split('{')[0]!.split(',').map((s) => s.trim()).includes(sel)).map((r) => r.split('{').pop()!).join(';')
// by name, so the same file runs as a before-check on an older build
const longCell = (t: string): boolean => (M as any).longCell(t)

test("a table's cells break only between words, never anywhere as the bubble's text does", () => {
  for (const sel of ['.md th', '.md td']) expect(rule(sel)).toContain('overflow-wrap:normal')
})

test('a wide table scrolls sideways in its own box, not the page', () => {
  expect(rule('.md table')).toContain('display:block')
  expect(rule('.md table')).toContain('max-width:100%')
  expect(rule('.md table')).toContain('overflow-x:auto')
})

test('a cell of a few words keeps a readable width; a number, a name or a short word does not', () => {
  expect(rule('.md td.long')).toContain('min-width:10em')
  expect(longCell('Add a permanent redirect and update the sidebar link')).toBe(true)
  for (const t of ['1', 'Sam', 'Broken (404)', 'Yesterday']) expect(longCell(t)).toBe(false)
})
