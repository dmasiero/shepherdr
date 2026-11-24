import { expect, test } from 'bun:test'
import { mirrorFocus } from './focus.ts'

test("the box's focus reaches xterm's textarea as its own focus and blur, so the cursor blinks only there", () => {
  const got: string[] = []
  const textarea = { dispatchEvent: (e: Event) => (got.push(e.type), true) }
  mirrorFocus({ textarea }, true)
  mirrorFocus({ textarea }, false)
  expect(got).toEqual(['focus', 'blur'])
  // before xterm has opened, or once it's gone: nothing
  mirrorFocus(null, true)
  mirrorFocus({}, true)
  expect(got).toEqual(['focus', 'blur'])
})
