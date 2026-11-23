import { expect, test } from 'bun:test'
import { keyBytes, parseKey } from './input.ts'

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

test('a key name splits into its modifiers and its key', () => {
  expect(parseKey('ctrl+alt+up')).toEqual({ ctrl: true, alt: true, shift: false, base: 'up' })
  expect(parseKey('alt++')).toEqual({ ctrl: false, alt: true, shift: false, base: '+' })
  expect(parseKey('enter')).toEqual({ ctrl: false, alt: false, shift: false, base: 'enter' })
})

test('keys with modifiers are xterm’s bytes, so they go in beside the text too (SHEP-23)', () => {
  expect(keyBytes(['ctrl+l'], false)).toBe('\x0c')
  expect(keyBytes(['ctrl+L'], false)).toBe('\x0c')
  expect(keyBytes(['alt+B'], false)).toBe('\x1bB')
  expect(keyBytes(['ctrl+alt+c'], false)).toBe('\x1b\x03')
  expect(keyBytes(['ctrl+ '], false)).toBe('\0')
  // the cursor keys with a modifier ignore the cursor mode: CSI 1;<mod>
  expect(keyBytes(['ctrl+up', 'alt+down', 'ctrl+alt+left', 'shift+right'], true)).toBe('\x1b[1;5A\x1b[1;3B\x1b[1;7D\x1b[1;2C')
  expect(keyBytes(['ctrl+home', 'alt+end'], false)).toBe('\x1b[1;5H\x1b[1;3F')
  expect(keyBytes(['ctrl+pageup', 'alt+delete'], false)).toBe('\x1b[5;5~\x1b[3;3~')
  expect(keyBytes(['alt+enter', 'alt+esc', 'alt+tab', 'alt+backspace', 'ctrl+backspace'], false)).toBe('\x1b\r\x1b\x1b\x1b\t\x1b\x7f\x08')
  // no bytes here: left to terminal.keys
  expect(keyBytes(['ctrl+enter'], false)).toBeNull()
  expect(keyBytes(['ctrl+tab'], false)).toBeNull()
  expect(keyBytes(['ctrl+1'], false)).toBeNull()
  expect(keyBytes(['shift+a'], false)).toBeNull()
  expect(keyBytes(['a'], false)).toBeNull()
})
