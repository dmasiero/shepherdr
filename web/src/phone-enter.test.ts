// fork: Enter sends on phone (SHEP-123)
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { boxHint, boxSends, enterLines, KEY, setEnterSends } from './phone-enter.ts'

const enter = { key: 'Enter', shiftKey: false }

test('on by default: Enter sends everywhere, as before, and the return key says Send', () => {
  for (const touch of [false, true]) {
    const lines = enterLines(true, touch)
    expect(lines).toBe(false)
    expect(boxSends(enter, lines)).toBe(true)
    expect(boxHint(lines)).toBe('send')
  }
})

test('off on a phone: Enter adds a new line, the return key shows a return, Ctrl/Cmd+Enter still sends', () => {
  const lines = enterLines(false, true)
  expect(lines).toBe(true)
  expect(boxSends(enter, lines)).toBe(false)
  expect(boxHint(lines)).toBe('enter')
  expect(boxSends({ ...enter, ctrlKey: true }, lines)).toBe(true)
  expect(boxSends({ ...enter, metaKey: true }, lines)).toBe(true)
})

test('off on a computer: nothing changes, Enter sends', () => {
  const lines = enterLines(false, false)
  expect(lines).toBe(false)
  expect(boxSends(enter, lines)).toBe(true)
  expect(boxHint(lines)).toBe('send')
})

test('Shift+Enter, an IME composing a word and other keys never send, in either mode', () => {
  for (const lines of [false, true]) {
    expect(boxSends({ ...enter, shiftKey: true }, lines)).toBe(false)
    expect(boxSends({ ...enter, shiftKey: true, ctrlKey: true }, lines)).toBe(false)
    expect(boxSends({ ...enter, isComposing: true }, lines)).toBe(false)
    expect(boxSends({ ...enter, isComposing: true, ctrlKey: true }, lines)).toBe(false)
    expect(boxSends({ ...enter, keyCode: 229 }, lines)).toBe(false)
    expect(boxSends({ key: 'a', shiftKey: false }, lines)).toBe(false)
  }
})

const g = globalThis as any
const had = g.localStorage
const store = new Map<string, string>()
g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) }
// the fake goes after this file: other tests see no page
afterAll(() => (g.localStorage = had))

test('kept on this device: off writes its key, on takes it away', () => {
  setEnterSends(false)
  expect(store.get(KEY)).toBe('0')
  expect(KEY).toBe('shepherdr.enterSends')
  setEnterSends(true)
  expect(store.has(KEY)).toBe(false)
})

test('the message box asks the rule, and the pickers still take Enter before it', () => {
  const box = readFileSync(new URL('../plugins/chat/client.tsx', import.meta.url), 'utf8')
  expect(box).toContain('const lines = enterLines(useEnterSends(), useMemo(hasEnterSwitch, []))')
  expect(box).toContain('enterKeyHint={boxHint(lines)')
  const keys = box.slice(box.indexOf('if (paths.onKey(e,'), box.indexOf('go(e.ctrlKey || e.metaKey)'))
  const order = ['paths.onKey', 'ment.onKey', 'slash.onKey', 'boxSends(']
  expect(order.map((w) => keys.indexOf(w)).every((at, i, all) => at >= 0 && (i === 0 || at > all[i - 1]))).toBe(true)
})

test('Settings › General shows the switch only where it does something', () => {
  const s = readFileSync(new URL('./settings.tsx', import.meta.url), 'utf8')
  expect(s).toContain('{hasEnterSwitch() && (')
  expect(s).toContain('<Tgl label="Enter sends on this device" on={enterSends} onChange={setEnterSends} />')
})
