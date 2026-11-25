import { expect, test } from 'bun:test'
import { acrossFold } from './fold.ts'

const wide = { phone: false, pane: null, task: null, term: false, tterm: false, termTask: false } as const
/** the UI after a switch and its patch, as the plugin applies it */
const flip = (ui: Parameters<typeof acrossFold>[0], before: Parameters<typeof acrossFold>[1] = null) => {
  const next = { ...ui, phone: !ui.phone }
  return { ...next, ...acrossFold(next, before) }
}
/** how many of your own terminals each layout draws: the drawer on a wide screen, the Terminal pane (any width) */
const shown = (ui: Parameters<typeof acrossFold>[0]) => (!ui.phone && (ui.term || ui.tterm) ? 1 : 0) + (ui.pane === 'terminal' ? 1 : 0)

test("a space's terminal open on the wide screen is the phone's Terminal pane folded, and the drawer again unfolded", () => {
  const open = { ...wide, term: true }
  const folded = flip(open)
  expect(folded).toMatchObject({ phone: true, pane: 'terminal', termTask: false, term: false })
  expect(shown(folded)).toBe(1)
  const unfolded = flip(folded)
  expect(unfolded).toMatchObject({ phone: false, pane: null, term: true })
  expect(shown(unfolded)).toBe(1)
})

test('one opened on the folded phone is one terminal unfolded, never the drawer and the pane both', () => {
  // the old bug: `term` still true from the wide screen, the phone's pane opened on top of it
  const folded = { ...wide, phone: true, term: true, pane: 'terminal' as const }
  const unfolded = flip(folded)
  expect(shown(unfolded)).toBe(1)
  expect(unfolded.pane).toBeNull()
})

test('closed on the phone stays closed unfolded', () => {
  const folded = flip({ ...wide, term: true })
  const unfolded = flip({ ...folded, pane: null })
  expect(shown(unfolded)).toBe(0)
})

test("a task's terminal moves with its task, and the pane it took is given back", () => {
  const task = { ...wide, pane: 'tasks' as const, task: 't1', tterm: true }
  const folded = flip(task)
  expect(folded).toMatchObject({ pane: 'terminal', termTask: true, task: 't1', tterm: false })
  expect(flip(folded)).toMatchObject({ pane: 'tasks', task: 't1', tterm: true, termTask: false })
  // a space's terminal beside the Artifacts pane: the pane comes back on unfolding
  const folded2 = flip({ ...wide, pane: 'artifacts', term: true })
  expect(folded2.pane).toBe('terminal')
  expect(flip(folded2, 'artifacts')).toMatchObject({ pane: 'artifacts', term: true })
})

test('no terminal open: a fold changes nothing', () => {
  expect(acrossFold({ ...wide, phone: true, pane: 'tasks', task: 't1' })).toEqual({})
  expect(acrossFold({ ...wide, pane: 'tasks' })).toEqual({})
})
