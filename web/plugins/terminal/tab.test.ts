import { expect, test } from 'bun:test'
import type { Place } from '@shared/types.ts'
import { tabTermFor } from './tab.ts'

const places = [
  { id: 'dev', chat: 'p:dev', tabs: [{ term: 't:shell1' }] },
  { id: 'ops', chat: 'p:ops', tabs: [{ term: 't:shell2' }] },
] as unknown as Place[]

test("a space tab's terminal shows in its space column, never in a task's chat (SHEP-27)", () => {
  expect(tabTermFor('t:shell1', undefined, 'p:dev', places)).toBe(true)
  expect(tabTermFor('t:shell1', { 't:shell1': 'terminal' }, 'p:dev', places)).toBe(true)
  // a task's chat in the side panel keeps its conversation
  expect(tabTermFor('t:shell1', undefined, 'dev-1#3', places)).toBe(false)
  expect(tabTermFor('t:shell1', { 't:shell1': 'terminal' }, 'dev-1#3', places)).toBe(false)
  // another space's column (a second pane) keeps its Assistant
  expect(tabTermFor('t:shell1', undefined, 'p:ops', places)).toBe(false)
})

test('a tab switched to Chat, or no tab terminal, overrides nothing', () => {
  expect(tabTermFor('t:shell1', { 't:shell1': 'chat' }, 'p:dev', places)).toBe(false)
  expect(tabTermFor(null, undefined, 'p:dev', places)).toBe(false)
  expect(tabTermFor('p:dev', undefined, 'p:dev', places)).toBe(false)
})
