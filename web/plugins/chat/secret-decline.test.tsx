// SHEP-76: the web's secret card has Decline beside Save, as the window's. Decline sends the same action with value
// null and its card (so the service declines, never removes a kept secret), and the card then ends on "Declined".
// client.tsx pulls in the whole app, so SecretCard runs from its own text (as web/src/recipe-preset.test.tsx runs
// Form), with the real React and small stand-ins for the app's parts; a tiny hooks shim lets a press re-render it.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import clsx from 'clsx'

const source = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
const text = source.match(/\nexport function SecretCard\([\s\S]*?\n}\n/)![0].replace('export function', 'function')
const js = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } as any }).transformSync(text)

const el = (tag: string) => (p: any) => React.createElement(tag, p, p.children)
const parts = {
  CardShell: (p: any) => React.createElement('section', { 'data-title': p.title }, p.children),
  Primary: ({ soft, ...p }: any) => React.createElement('button', p, p.children),
  Sent: el('div'), Tabs: el('div'), Tab: ({ on, ...p }: any) => React.createElement('button', p, p.children),
  SecretField: (p: any) => React.createElement('input', { type: 'password', 'aria-label': p.label, value: p.value, readOnly: true }),
  CheckIcon: () => null, KeyIcon: () => null, ic: '',
}

// a hooks shim: state kept across renders, so a press's setState shows on the next render
function mount(act: (a: any) => Promise<any>, props: any) {
  const slots: any[] = []
  let i = 0
  const useState = (init: any) => {
    const k = i++
    if (!(k in slots)) slots[k] = init
    return [slots[k], (v: any) => { slots[k] = typeof v === 'function' ? v(slots[k]) : v }]
  }
  const names = Object.keys(parts)
  const Card = new Function('React', 'useState', 'clsx', 'act', ...names, `${js}; return SecretCard`)(React, useState, clsx, act, ...names.map((n) => (parts as any)[n]))
  const render = () => { i = 0; return Card(props) as React.ReactElement }
  return { render, html: () => renderToStaticMarkup(render()) }
}

// every element of a rendered tree, function components expanded
function all(node: any, out: any[] = []): any[] {
  if (Array.isArray(node)) { for (const n of node) all(n, out); return out }
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), out)
  out.push(node)
  all(node.props?.children, out)
  return out
}
const button = (tree: any, words: string) => all(tree).find((n) => n.type === 'button' && [n.props.children].flat().includes(words))

const ask = { id: 'secret:t1:UNITED_SMS_CODE', name: 'UNITED_SMS_CODE', why: 'the code by text', levels: [{ id: 'p::sp1', label: 'This space' }, { id: 'm:', label: 'This computer' }, { id: 'all', label: 'Everywhere' }] }
const chat = { key: 'pers' }

test('the card shows Decline beside Save', () => {
  const card = mount(async () => ({ ok: true }), { ask, chat })
  const h = card.html()
  expect(h).toContain('>Decline</button>')
  expect(h).toContain('>Save</button>')
  expect(h.indexOf('>Decline<')).toBeLessThan(h.indexOf('>Save<'))
  // Decline needs no value; Save does
  expect(button(card.render(), 'Decline').props.disabled).toBe(false)
  expect(button(card.render(), 'Save').props.disabled).toBe(true)
})

test('Decline sends value null with its card, then the card ends on a quiet Declined line', async () => {
  const sent: any[] = []
  const card = mount(async (a) => { sent.push(a); return { ok: true } }, { ask, chat })
  await button(card.render(), 'Decline').props.onClick()
  await Bun.sleep(0)
  expect(sent).toEqual([{ type: 'secret', level: 'p::sp1', name: 'UNITED_SMS_CODE', value: null, card: { chat: 'pers', id: ask.id } }])
  const h = card.html()
  expect(h).toContain('>Declined</p>')
  expect(h).not.toContain('>Decline</button>')
  expect(h).not.toContain('type="password"')
})

test("a Decline the service refused says why, and the card stays", async () => {
  const card = mount(async () => { throw Object.assign(new Error('No such terminal.'), { status: 400 }) }, { ask, chat })
  await button(card.render(), 'Decline').props.onClick()
  await Bun.sleep(0)
  const h = card.html()
  expect(h).toContain('No such terminal.')
  expect(h).toContain('>Decline</button>')
})
