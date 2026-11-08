import { expect, test } from 'bun:test'
import { inputOf } from './screen.ts'

test('a phone or tablet types through the tap box, in every terminal', () => {
  // SHEP-19: a tablet-wide Android Chrome's tab terminal (from the + menu) got no box, so no keyboard
  for (const device of ['phone', 'tablet'] as const)
    for (const panel of [true, false]) expect(inputOf(device, panel)).toEqual({ typed: false, touch: true })
})

test('a desktop types by keys, as before', () => {
  expect(inputOf('desktop', true)).toEqual({ typed: true, touch: false })
  expect(inputOf('desktop', false)).toEqual({ typed: false, touch: false })
})
