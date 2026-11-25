// fork: Jump to bottom: when the round arrow shows, what its badge counts, and that the app's scroll bars are hidden.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { badge, freshSince, jumpNow, jumpOf, newestAt, setJump } from './jump.ts'

test('at the end, or just above it, there is no button', () => {
  expect(jumpOf(0, 600, 0).show).toBe(false)
  expect(jumpOf(79, 600, 5).show).toBe(false)
})

test('a little way up it waits; past about three quarters of a screen it shows', () => {
  expect(jumpOf(300, 600, 0).show).toBe(false)
  expect(jumpOf(451, 600, 0).show).toBe(true)
  // a short window still needs 200 px
  expect(jumpOf(150, 160, 0).show).toBe(false)
  expect(jumpOf(201, 160, 0).show).toBe(true)
})

test('something new shows it at any distance up, with the count', () => {
  expect(jumpOf(100, 600, 2)).toEqual({ show: true, fresh: 2 })
})

const msgs = [
  { who: 'agent', at: 10 },
  { who: 'you', at: 20 },
  { who: 'agent', at: 30, activity: {} },
  { who: 'agent', at: 40 },
]

test('the count starts at the newest message from someone else', () => {
  expect(newestAt(msgs)).toBe(40)
  expect(newestAt([{ who: 'you', at: 5 }])).toBe(0)
})

test('only others\' messages after you left count: not yours, not tool steps, not earlier pages', () => {
  const later = [{ who: 'agent', at: 1 }, ...msgs, { who: 'you', at: 50 }, { who: 'agent', at: 60 }, { who: 'agent', at: 70, activity: {} }, { who: 'agent', at: 80 }]
  expect(freshSince(later, 40)).toBe(2)
  expect(freshSince(msgs, 40)).toBe(0)
})

test('the badge', () => {
  expect(badge(0)).toBe('')
  expect(badge(3)).toBe('3')
  expect(badge(150)).toBe('99+')
})

test('the store keeps one answer per chat and drops a hidden count', () => {
  setJump('p:a', { show: true, fresh: 2 })
  expect(jumpNow('p:a')).toEqual({ show: true, fresh: 2 })
  expect(jumpNow('p:b').show).toBe(false)
  setJump('p:a', { show: false, fresh: 2 })
  expect(jumpNow('p:a')).toEqual({ show: false, fresh: 0 })
})

test('the chat, panes, the list and sheets hide their scroll bars; the terminal keeps its own', () => {
  const css = readFileSync(new URL('../../src/ds.css', import.meta.url), 'utf8')
  const rule = css.split('\n').find((l) => l.endsWith('{scrollbar-width:none}') && l.startsWith('.side,.scroll'))
  expect(rule).toBeDefined()
  for (const sel of ['.side', '.scroll', '.dlg', '.sheet', '.drawer']) expect(rule!.split('{')[0]!.split(',')).toContain(sel)
  expect(rule).not.toContain('term')
  expect(css).toContain('.scroll,.win .nav')
  expect(css).toMatch(/:is\(\.side,\.scroll,[^)]*\)::-webkit-scrollbar\{display:none\}/)
  expect(css).toMatch(/@media\(prefers-reduced-motion:reduce\)\{\.jmp\{animation:none\}\}/)
})
