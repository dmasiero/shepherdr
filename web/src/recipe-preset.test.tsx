// SHEP-70 (upstream #1212): the web viewer's form starts each field on its preset value; a preset select has no blank.
// Recipe.tsx pulls in the app's kernel (a whole page), so its Form runs from its own text, as other web tests run a
// handler: with the real React, clsx and core/recipe.js, and a plain button for Primary.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import clsx from 'clsx'
import * as R from '../../core/recipe.js'

const source = readFileSync(new URL('./screens/Recipe.tsx', import.meta.url), 'utf8')
const text = source.match(/\nfunction Form\([\s\S]*?\n}\n/)![0]
const js = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } as any }).transformSync(text)
const Primary = (p: any) => React.createElement('button', p)
const Form = new Function('React', 'useState', 'clsx', 'Primary', 'formReply', `${js}; return Form`)(React, React.useState, clsx, Primary, (R as any).formReply)

const html = (fields: any[]) => renderToStaticMarkup(React.createElement(Form, { b: { type: 'form', id: 'f', fields }, reply: async () => true }))
const selects = (h: string) => [...h.matchAll(/<select[^>]*>(.*?)<\/select>/g)].map((m) => [...m[1].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((o) => ({ text: o[2], on: /selected/.test(o[1]) })))

test('a preset select starts on its value, with no blank option', () => {
  const [s] = selects(html([{ name: 'gym', kind: 'select', options: ['Keep', 'Cancel'], value: 'Cancel' }]))
  expect(s).toEqual([{ text: 'Keep', on: false }, { text: 'Cancel', on: true }])
})

test('a select without a value keeps its blank first option, picked', () => {
  const [s] = selects(html([{ name: 'news', kind: 'select', options: ['Keep', 'Cancel'] }]))
  expect(s).toEqual([{ text: '', on: true }, { text: 'Keep', on: false }, { text: 'Cancel', on: false }])
})

test('a preset text, textarea and checkbox start on theirs', () => {
  const h = html([{ name: 't', kind: 'text', value: 'hello' }, { name: 'a', kind: 'textarea', value: 'long words' }, { name: 'c', kind: 'checkbox', value: true }, { name: 'd', kind: 'checkbox' }])
  expect(h).toContain('value="hello"')
  expect(h).toMatch(/<textarea[^>]*>long words<\/textarea>/)
  expect((h.match(/type="checkbox"[^>]*checked/g) ?? []).length).toBe(1)
})
