// fork: SHEP-34
import { test, expect } from 'bun:test'
import { installHeldLine } from './install-held.ts'

test('says which machine, what is wrong first, and that the sync waits', () => {
  const now = Date.UTC(2026, 10, 9, 12)
  const line = installHeldLine({ problems: ['shared lib copies differ: x.', 'missing: y'], since: now - 3 * 86400_000, held: true }, 'nextgate', now)
  expect(line).toStartWith("Shepherdr's install on nextgate isn't whole since ")
  expect(line).toContain(': shared lib copies differ: x (and 1 more).')
  expect(line).toEndWith(' The sync to other machines is held until it is.')
})

test('not held: no word about the sync', () => {
  const line = installHeldLine({ problems: ['missing: y'], since: 0, held: false }, '')
  expect(line).toBe("Shepherdr's install on this machine isn't whole: missing: y.")
})
