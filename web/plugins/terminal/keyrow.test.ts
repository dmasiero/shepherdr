// fork: the terminal's key row leaves the phone's keyboard as it was, and with the keyboard up the terminal shrinks to
// fit above it (keyrow.ts, ds.css's .kb rules).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { focusAfterPress, keyRow } from './keyrow.ts'

const client = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
const ds = readFileSync(new URL('../../src/ds.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8')

test('a finger or a pen on a key never hands the keys to the terminal (that would bring the keyboard up); a mouse does', () => {
  expect(focusAfterPress('touch')).toBe(false)
  expect(focusAfterPress('pen')).toBe(false)
  expect(focusAfterPress('mouse')).toBe(true)
  // Enter or Space on a focused key: no pointer at all, as on a desktop
  expect(focusAfterPress('')).toBe(true)
})

test('a press keeps the focus where it was, and the row remembers how the latest press was made, once', () => {
  const row = keyRow()
  let prevented = 0
  row.onMouseDown({ preventDefault: () => prevented++ })
  expect(prevented).toBe(1)
  row.onPointerDown({ pointerType: 'touch' })
  expect(focusAfterPress(row.last())).toBe(false)
  // the next click with no pointer before it (a key's Enter) is not taken for the finger before
  expect(row.last()).toBe('')
  row.onPointerDown({ pointerType: 'mouse' })
  expect(focusAfterPress(row.last())).toBe(true)
})

test('the key row is wired so: its presses never move focus, and its keys focus the box only through focusAfterPress', () => {
  expect(client).toContain('<div className="keys" onPointerDown={row.onPointerDown} onMouseDown={row.onMouseDown}>')
  const row = client.slice(client.indexOf('<div className="keys"'), client.indexOf('</div>', client.indexOf('<div className="keys"')))
  expect(row).not.toContain('cap.current?.focus()')
  const send = client.slice(client.indexOf('const sendKey'), client.indexOf('return (', client.indexOf('const sendKey')))
  expect(send).not.toContain('cap.current?.focus()')
  expect(send).toContain('keysHere()')
})

test('with the keyboard up the terminal fits above it: no floor from its rows, the box and bottom bar step aside', () => {
  expect(app).toContain("ui.keyboard && 'kb'")
  // the drawer under a chat or a task: a column of bar, terminal and keys whose terminal gives up rows
  expect(ds).toContain('.kb .col>.tdr{flex:0 1 auto;display:flex;flex-direction:column}')
  expect(ds).toContain('.kb .col>.tdr>.tw{flex:0 1 auto;min-height:0;display:flex;flex-direction:column}')
  expect(ds).toContain('.kb .col>.tdr .termbox{flex:0 1 auto;min-height:0}')
  // the phone's terminal pane: its rows and its 240px floor held it at its old height
  expect(ds).toContain('.kb .pane .scroll>.tdr .tw,.kb .termbox.fill{min-height:0}')
  // the terminal has the keys: the message box and the phone's bottom bar make room
  expect(ds).toContain('.kb .col:has(.tcap:focus)>.foot,.app.kb:has(.tcap:focus) .bar{display:none}')
  // only with the keyboard up: no rule of these without .kb
  for (const r of ['.col>.tdr>.tw{flex:0 1 auto', '.termbox.fill{min-height:0}', ':has(.tcap:focus)']) {
    for (const at of ds.split(r).slice(0, -1)) expect(at.slice(at.lastIndexOf('}') + 1)).toContain('.kb')
  }
})
