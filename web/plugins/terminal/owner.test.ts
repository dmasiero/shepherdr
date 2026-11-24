import { expect, test } from 'bun:test'
import { ASK_WAIT, mayAsk, stillHolds } from './owner.ts'

test('a page holds the size until another screen moves it to a size it did not ask for', () => {
  // its own ask came back: still its
  expect(stillHolds(true, '65x10', '65x10', 1000, 1100)).toBe(true)
  // the desktop took it (long after this page last asked): let go
  expect(stillHolds(true, '169x8', '65x10', 1000, 1000 + ASK_WAIT + 1)).toBe(false)
  // a size from before its own ask lands: no takeover
  expect(stillHolds(true, '169x8', '65x10', 1000, 1200)).toBe(true)
  // a page that let go never takes it back from a size message, only from you using it
  expect(stillHolds(false, '65x10', '65x10', 1000, 1100)).toBe(false)
})

const doc = (visibilityState: string, focused: boolean) => ({ visibilityState, hasFocus: () => focused })

test('only the window in front that holds the terminal asks for a size', () => {
  expect(mayAsk(true, doc('visible', true))).toBe(true)
  // an idle desktop tab showing what the phone set: never
  expect(mayAsk(false, doc('visible', true))).toBe(false)
  // a hidden tab or a window in the background: never, even holding it
  expect(mayAsk(true, doc('hidden', false))).toBe(false)
  expect(mayAsk(true, doc('visible', false))).toBe(false)
  expect(mayAsk(true, undefined)).toBe(false)
})
