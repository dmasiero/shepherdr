// fork: Terminal stays across spaces. Your own terminal is tabs, one per space, kept across a space switch.
import { beforeEach, expect, test } from 'bun:test'
import { getState, setUI } from '@client/kernel.ts'
import { activeOf, addTab, closeTab, openIn, tabsOf } from './tabs.ts'
import { followFold, spaceTermRow } from './menu.ts'

const A = 'p:mac:a', B = 'p:vm:b'

beforeEach(() => setUI({ phone: false, term: false, tterm: false, pane: null, termTask: false, task: null, terms: [], termAt: null, at: A }))

test('opened in A, then B: A keeps showing; opened again in B, B is a second tab beside it', () => {
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A], termAt: A })
  setUI({ at: B })
  // the switch leaves it open on A's tab, and the row in B is not checked (B has no terminal showing)
  expect(getState().ui).toMatchObject({ term: true, terms: [A], termAt: A })
  expect(spaceTermRow(getState().ui).on).toBe(false)
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B], termAt: B })
  expect(spaceTermRow(getState().ui).on).toBe(true)
  // back in A: its tab is picked, not a new one
  setUI({ at: A })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A, B], termAt: A })
  // the row again on A's showing tab hides the terminal, its tabs kept
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: false, terms: [A, B], termAt: A })
})

test('hidden, then shown from a space with no tab: it comes back as it was, not with a new tab', () => {
  setUI({ terms: [A], termAt: A, at: B })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ term: true, terms: [A], termAt: A })
  // the bar's + starts B's
  setUI(addTab(getState().ui, B))
  expect(getState().ui).toMatchObject({ terms: [A, B], termAt: B })
  expect(addTab(getState().ui, B)).toEqual({ terms: [A, B], termAt: B })
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
  expect(openIn({ terms: [], termAt: null }, A, true).show).toBe(false)
})

test("a phone: the Terminal screen shows the tabs; going to B's chat and back to the terminal finds A's", () => {
  setUI({ phone: true })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A], termAt: A })
  setUI({ pane: null, at: B })
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A], termAt: A })
  // in it, the row again (Ctrl+`) adds B's
  spaceTermRow(getState().ui).run!()
  expect(getState().ui).toMatchObject({ pane: 'terminal', terms: [A, B], termAt: B })
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
