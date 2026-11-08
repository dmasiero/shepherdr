// fork: Close on the web's tab bar (close.ts, SHEP-28): pool.fan's Assistant had died, and Close on its Assistant tab
// asked to close the whole space, which went.
import { expect, test } from 'bun:test'
import { closeOf } from './close.ts'

const A = { assistant: true }, T = { assistant: false }

test('an Assistant tab with no Assistant open closes nothing, never the space', () => {
  expect(closeOf([A, T], A, { tab: false, live: false })).toBe('none')
  expect(closeOf([A], A, { tab: false, live: false })).toBe('none')
})

test('the other tab of such a space is its last: Close asks to close the space, as before', () => {
  expect(closeOf([A, T], T, { tab: false, live: false })).toBe('space')
})

test('a live Assistant closes as the Assistant; a window Assistant tab with no agent yet is a tab like any other', () => {
  expect(closeOf([A, T], A, { tab: true, live: true })).toBe('assistant')
  expect(closeOf([A, T], A, { tab: true, live: false })).toBe('tab')
  expect(closeOf([A], A, { tab: true, live: false })).toBe('space')
  expect(closeOf([A, T, T], T, { tab: false, live: false })).toBe('tab')
})
