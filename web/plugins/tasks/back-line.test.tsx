// SHEP-81: a task row back from a snooze by its time says only "Back from snooze"; one woken by an event keeps why
// ("Back from snooze · Asked a question"). client.tsx pulls in the whole app, so Line runs from its own text (as
// secret-decline.test.tsx runs SecretCard) with the real core/snooze.js and React, and stand-ins for the rest.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import clsx from 'clsx'
import * as SZ from '../../../core/snooze.js'

const source = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
const text = source.match(/\nfunction Line\([\s\S]*?\n}\n/)![0]
const js = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } as any }).transformSync(text)
const Line = new Function('React', 'clsx', 'SZ', 'capital', 'fit', 'rowClass', 'SnoozeIcon', `${js}\nreturn Line`)(
  React, clsx, SZ, (s: string) => s, (s: string) => s, () => '', () => null,
)

const row = (woke?: string) => renderToStaticMarkup(React.createElement(Line, { glyph: null, title: 'Coverage', ref_: 'SHEP-79', sub: 'working', woke }))
  .replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean)

test('back by its time: only "Back from snooze"', () => {
  const words = row(SZ.WHY.time)
  expect(words).toContain('Back from snooze')
  expect(words.join(' ')).not.toContain("Time's up")
})

test('back by an event: "Back from snooze · <why>"', () => {
  for (const why of [SZ.WHY.asked, SZ.WHY.blocked, SZ.WHY.ready]) expect(row(why)).toContain(`Back from snooze · ${why}`)
})

test('not back: its own line', () => {
  const words = row()
  expect(words).toContain('working')
  expect(words.join(' ')).not.toContain('Back from snooze')
})
