// SHEP-84: the Tasks list's shut Done is a heading like Working's or Snoozed's ("Done 155", the closed chevron), not a
// quiet "155 done" line. client.tsx pulls in the whole app, so FoldHeading and GroupHeading run from their own text
// (as back-line.test.tsx runs Line) with React and stand-ins for the icons.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import clsx from 'clsx'

const source = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
const part = (name: string) => source.match(new RegExp(`\\nfunction ${name}\\([\\s\\S]*?\\n}\\n`))![0]
const js = new Bun.Transpiler({ loader: 'tsx', tsconfig: { compilerOptions: { jsx: 'react' } } as any }).transformSync(part('FoldHeading') + part('GroupHeading'))
const icon = (name: string) => () => React.createElement('i', { 'data-icon': name })
const GroupHeading = new Function('React', 'clsx', 'ic', 'NextIcon', 'DownIcon', `${js}\nreturn GroupHeading`)(React, clsx, 'ic', icon('next'), icon('down'))

const heading = (props: object) => renderToStaticMarkup(React.createElement(GroupHeading, props))
const words = (html: string) => html.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean)
const shut = { shut: true, toggle: () => {} }

test('the shut Done draws the group heading, with the open Done\'s label and a shut fold', () => {
  const branch = source.match(/if \(g\.key === 'done' && g\.shut\) \{[\s\S]*?\n {10}\}/)![0]
  expect(branch).toContain('<GroupHeading label={g.label}')
  expect(branch).toContain('flip="group:done"')
  expect(branch).toContain('shut: true')
  expect(source).not.toContain('function DoneLine')
})

test('shut Done reads "Done 155", as "Snoozed 3" does, with the closed chevron', () => {
  const done = heading({ label: 'Done', count: 155, flip: 'group:done', fold: shut })
  const snoozed = heading({ label: 'Snoozed', count: 3, flip: 'group:snoozed', fold: shut })
  expect(words(done)).toEqual(['Done', '155'])
  expect(done).toContain('data-icon="next"')
  expect(done).toContain('data-flip="group:done"')
  expect(done).toContain('aria-expanded="false"')
  // the same markup but its words: same colour, size, weight and spacing
  expect(done.replace('group:done', 'X').replace(/Done/g, 'L').replace('155', 'N')).toBe(snoozed.replace('group:snoozed', 'X').replace(/Snoozed/g, 'L').replace('>3<', '>N<'))
})

test('all done today: the heading\'s quiet note, "Done · today 3"', () => {
  expect(words(heading({ label: 'Done', note: 'today', count: 3, fold: shut }))).toEqual(['Done', '· today', '3'])
})
