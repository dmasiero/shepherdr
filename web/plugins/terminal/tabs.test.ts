// fork: Terminal stays across spaces. Your own terminal is tabs, one per space, kept across a space switch.
import { beforeEach, expect, test } from 'bun:test'
import { getState, setUI } from '@client/kernel.ts'
import { activeOf, addTab, closeTab, nextTab, openIn, tabPlace, tabsOf } from './tabs.ts'
import { followFold, spaceTermRow } from './menu.ts'

const A = 'p:mac:a', B = 'p:vm:b'

beforeEach(() => setUI({ phone: false, term: false, tterm: false, pane: null, termTask: false, task: null, terms: [], termAt: null, at: A }))

test('opened in A, then B: A keeps showing; opened again in B, B is a second tab beside it', () => {
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A], termAt: A })
  setUI({ at: B })
  // the switch leaves it open on A's tab; the row has no check mark (Terminal menu row fixes)
  expect(getState().ui).toMatchObject({ term: true, terms: [A], termAt: A })
  expect(spaceTermRow(getState().ui).on).toBeUndefined()
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B], termAt: B })
  // fork: Terminal again adds a tab. Back in A, while it shows: another tab for A, its own shell
  setUI({ at: A })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${A}~2`], termAt: `${A}~2` })
  // the row again on A's showing tab adds a third, never hides
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${A}~2`, `${A}~3`], termAt: `${A}~3` })
  // hidden (the ⌄), then the row: back as it was, no new tab
  setUI({ term: false, termAt: `${A}~2` })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${A}~2`, `${A}~3`], termAt: `${A}~2` })
})

test("Terminal again adds a tab: a space's tabs are numbered, the lowest free first; each its own shell", () => {
  expect(tabPlace(A)).toEqual({ place: A, n: 1 })
  expect(tabPlace(`${A}~2`)).toEqual({ place: A, n: 2 })
  expect(nextTab([], A)).toBe(A)
  expect(nextTab([A], A)).toBe(`${A}~2`)
  expect(nextTab([A, `${A}~3`], A)).toBe(`${A}~2`)
  // the first closed, the next takes its place
  expect(nextTab([`${A}~2`], A)).toBe(A)
  expect(addTab({ terms: [A, B], termAt: B }, A)).toEqual({ terms: [A, B, `${A}~2`], termAt: `${A}~2` })
  // hidden, shown from a space with two tabs: the one of its own last showing, else its newest
  expect(openIn({ terms: [A, B, `${A}~2`], termAt: B }, A, false)).toEqual({ terms: [A, B, `${A}~2`], termAt: `${A}~2`, show: true })
  expect(openIn({ terms: [A, B, `${A}~2`], termAt: A }, A, false)).toEqual({ terms: [A, B, `${A}~2`], termAt: A, show: true })
  // a tab of a space gone goes with it
  expect(tabsOf({ terms: [A, `${B}~2`], termAt: null }, (p) => p !== B, A)).toEqual([A])
})

// fork: Terminal menu row fixes. Doug, in shepherdr with renix's and dotfiles' tabs hidden: Terminal showed only those.
test('hidden, then shown from a space with no tab: the others come back and its own is added beside them', () => {
  setUI({ terms: [A], termAt: A, at: B })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B], termAt: B })
  setUI({ terms: [A], termAt: A })
  // the bar's + starts B's, and again a second B
  setUI(addTab(getState().ui, B))
  expect(getState().ui).toMatchObject({ terms: [A, B], termAt: B })
  expect(addTab(getState().ui, B)).toEqual({ terms: [A, B, `${B}~2`], termAt: `${B}~2` })
})

test("closing a tab leaves the others, the one next to it showing; the last closes the terminal", () => {
  expect(closeTab({ terms: [A, B], termAt: B }, [A, B], B)).toEqual({ terms: [A], termAt: A, show: true })
  expect(closeTab({ terms: [A, B], termAt: B }, [A, B], A)).toEqual({ terms: [B], termAt: B, show: true })
  expect(closeTab({ terms: ['x', A, B], termAt: A }, ['x', A, B], A)).toEqual({ terms: ['x', B], termAt: 'x', show: true })
  expect(closeTab({ terms: [A], termAt: A }, [A], A)).toEqual({ terms: [], termAt: null, show: false })
})

test("tabs of spaces gone are dropped; none kept (a terminal open from before tabs) is the space you are in", () => {
  expect(tabsOf({ terms: [A, 'p:gone', B], termAt: null }, (p) => p !== 'p:gone', A)).toEqual([A, B])
  expect(tabsOf({ terms: [], termAt: null }, () => true, B)).toEqual([B])
  expect(activeOf([A, B], 'p:gone')).toBe(B)
  expect(activeOf([A, B], A)).toBe(A)
  // fork: shown from before tabs (none kept, A's showing): the row adds A's second (Terminal again adds a tab)
  expect(openIn({ terms: [], termAt: null }, A, true)).toEqual({ terms: [A, `${A}~2`], termAt: `${A}~2`, show: true })
})

test("a phone: the Terminal screen shows the tabs; going to B's chat and back to the terminal finds A's", () => {
  setUI({ phone: true })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A], termAt: A })
  setUI({ pane: null, at: B })
  // fork: B has none: B's is added beside A's (Terminal menu row fixes)
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A, B], termAt: B })
  // in it, the row again (Ctrl+`) adds B's second
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A, B, `${B}~2`], termAt: `${B}~2` })
})

test('fold and unfold carry the tabs along: one terminal, the same tabs', () => {
  const stop = followFold()
  try {
    setUI({ terms: [A, B], termAt: A, term: true, at: B })
    setUI({ phone: true })
    expect(getState().ui).toMatchObject({ pane: 'terminal', term: false, terms: [A, B], termAt: A })
    setUI({ phone: false })
    expect(getState().ui).toMatchObject({ pane: null, term: true, terms: [A, B], termAt: A })
  } finally { stop() }
})

// fork: Terminal menu row fixes, each case of Doug's recording
const C = 'p:mac:c'
test('hidden with other spaces\' tabs, Terminal in a space with none: they show and its tab is added, picked', () => {
  setUI({ terms: [A, B, `${B}~2`], termAt: `${B}~2`, at: C })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${B}~2`, C], termAt: C })
})

test('hidden, Terminal in a space with a tab: they show on its tab, none added', () => {
  setUI({ terms: [A, B], termAt: A, at: B })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B], termAt: B })
})

test('added twice, hidden with the ⌄, chosen again: every tab is back, none closed', () => {
  setUI({ terms: [A, B], termAt: B, at: B, term: true })
  spaceTermRow(getState().ui).run!()
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ terms: [A, B, `${B}~2`, `${B}~3`], termAt: `${B}~3` })
  setUI({ term: false })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${B}~2`, `${B}~3`], termAt: `${B}~3` })
  // and a fold and unfold while hidden or shown keeps all four
  const stop = followFold()
  try {
    setUI({ phone: true })
    expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A, B, `${B}~2`, `${B}~3`], termAt: `${B}~3` })
    setUI({ phone: false })
    expect(getState().ui).toMatchObject({ term: true, terms: [A, B, `${B}~2`, `${B}~3`], termAt: `${B}~3` })
  } finally { stop() }
})

test('showing other spaces\' tabs, Terminal in a space with none adds its first', () => {
  setUI({ terms: [A, B], termAt: B, at: C, term: true })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B, C], termAt: C })
})
