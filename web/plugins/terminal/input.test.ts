import { expect, test } from 'bun:test'
import { keyBytes, typedDiff } from './input.ts'

test("a person's keys are a terminal's bytes, so they go in with their text and never wait (SHEP-20)", () => {
  expect(keyBytes(['enter'], false)).toBe('\r')
  expect(keyBytes(['esc'], false)).toBe('\x1b')
  expect(keyBytes(['tab'], false)).toBe('\t')
  expect(keyBytes(['shift+tab'], false)).toBe('\x1b[Z')
  expect(keyBytes(['backspace'], false)).toBe('\x7f')
  expect(keyBytes(['delete'], false)).toBe('\x1b[3~')
  expect(keyBytes(['pageup', 'pagedown'], false)).toBe('\x1b[5~\x1b[6~')
  expect(keyBytes(['ctrl+c'], false)).toBe('\x03')
  expect(keyBytes(['ctrl+a', 'ctrl+z'], false)).toBe('\x01\x1a')
  expect(keyBytes(['ctrl+['], false)).toBe('\x1b')
  expect(keyBytes(['alt+b'], false)).toBe('\x1bb')
})

test('the cursor keys follow the program’s cursor mode', () => {
  expect(keyBytes(['up', 'down', 'right', 'left', 'home', 'end'], false)).toBe('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F')
  expect(keyBytes(['up', 'down', 'right', 'left', 'home', 'end'], true)).toBe('\x1bOA\x1bOB\x1bOC\x1bOD\x1bOH\x1bOF')
})

test('a key with no bytes here leaves the whole press to terminal.keys', () => {
  expect(keyBytes(['f5'], false)).toBeNull()
  expect(keyBytes(['enter', 'ctrl+1'], false)).toBeNull()
})

test('the touch box types what changed: new letters, a Backspace per letter taken back, Enter for a newline', () => {
  expect(typedDiff('', 'ls')).toBe('ls')
  // a keyboard composing a word: each letter once, in order
  expect(typedDiff('h', 'he')).toBe('e')
  expect(typedDiff('he', 'hel')).toBe('l')
  // its correction swaps the word's end
  expect(typedDiff('teh', 'the')).toBe('\x7f\x7fhe')
  expect(typedDiff('hel', 'he')).toBe('\x7f')
  expect(typedDiff('ls', 'ls\n')).toBe('\r')
  expect(typedDiff('', '\n')).toBe('\r')
  expect(typedDiff('é', 'é')).toBe('')
})
