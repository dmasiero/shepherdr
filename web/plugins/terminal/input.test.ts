import { expect, test } from 'bun:test'
import { anyMod, EXTRA_KEYS, keyBytes, modText, NO_MODS, parseKey, tapMod, typedDiff, withMods } from './input.ts'

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

test('a key name splits into its modifiers and its key', () => {
  expect(parseKey('ctrl+alt+up')).toEqual({ ctrl: true, alt: true, shift: false, base: 'up' })
  expect(parseKey('alt++')).toEqual({ ctrl: false, alt: true, shift: false, base: '+' })
  expect(parseKey('enter')).toEqual({ ctrl: false, alt: false, shift: false, base: 'enter' })
})

test('keys with modifiers are xterm’s bytes, so the sticky Ctrl and Alt go in beside the text too (SHEP-23)', () => {
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

test('a tap on Ctrl or Alt engages it; a second tap lets it go', () => {
  const ctrl = tapMod(NO_MODS, 'ctrl')
  expect(ctrl).toEqual({ ctrl: true, alt: false })
  expect(anyMod(ctrl)).toBe(true)
  expect(tapMod(ctrl, 'alt')).toEqual({ ctrl: true, alt: true })
  expect(tapMod(ctrl, 'ctrl')).toEqual(NO_MODS)
  expect(anyMod(NO_MODS)).toBe(false)
})

test('the engaged modifiers go on the next key, the row’s own keys too', () => {
  expect(withMods('up', { ctrl: true, alt: false })).toBe('ctrl+up')
  expect(withMods('enter', { ctrl: false, alt: true })).toBe('alt+enter')
  expect(withMods('ctrl+c', { ctrl: false, alt: true })).toBe('ctrl+alt+c')
  expect(withMods('ctrl+c', { ctrl: true, alt: false })).toBe('ctrl+c')
  expect(withMods('shift+tab', { ctrl: false, alt: true })).toBe('alt+shift+tab')
  expect(withMods('L', { ctrl: true, alt: false })).toBe('ctrl+l')
  expect(withMods('B', { ctrl: false, alt: true })).toBe('alt+B')
  expect(withMods('esc', NO_MODS)).toBe('esc')
})

test('typed text takes the modifiers on its first new character only, the rest in order after it', () => {
  const ctrl = { ctrl: true, alt: false }, alt = { ctrl: false, alt: true }
  expect(modText('l', ctrl)).toEqual([{ keys: ['ctrl+l'] }])
  expect(modText('L', ctrl)).toEqual([{ keys: ['ctrl+l'] }])
  expect(modText('b', alt)).toEqual([{ keys: ['alt+b'] }])
  expect(modText('c', { ctrl: true, alt: true })).toEqual([{ keys: ['ctrl+alt+c'] }])
  // a keyboard that puts in more at once (a suggestion): only its first letter is the combo
  expect(modText('cd ', ctrl)).toEqual([{ keys: ['ctrl+c'] }, { text: 'd ' }])
  // a correction's Backspaces first, as they are
  expect(modText('\x7f\x7fxy', ctrl)).toEqual([{ text: '\x7f\x7f' }, { keys: ['ctrl+x'] }, { text: 'y' }])
  // the keyboard's Enter is the Enter key
  expect(modText('\r', alt)).toEqual([{ keys: ['alt+enter'] }])
  expect(modText('\x7f', ctrl)).toEqual([{ text: '\x7f' }])
  // nothing engaged: the text as it is
  expect(modText('ls', NO_MODS)).toEqual([{ text: 'ls' }])
  expect(modText('', ctrl)).toEqual([])
})

test('the arrows take the sticky Ctrl and Alt, and Ctrl-C is the sticky Ctrl then c (SHEP-24)', () => {
  const ctrl = { ctrl: true, alt: false }
  expect(withMods('left', ctrl)).toBe('ctrl+left')
  expect(withMods('right', { ctrl: false, alt: true })).toBe('alt+right')
  expect(keyBytes(['left', 'right'], false)).toBe('\x1b[D\x1b[C')
  expect(keyBytes([withMods('left', ctrl), withMods('right', ctrl)], false)).toBe('\x1b[1;5D\x1b[1;5C')
  expect(modText('c', ctrl)).toEqual([{ keys: ['ctrl+c'] }])
})

test('the extra-keys bar is Termux’s two rows of seven, each key with the input it sends (SHEP-26)', () => {
  expect(EXTRA_KEYS.map((row) => row.map((x) => x.label))).toEqual([
    ['ESC', '/', '−', 'HOME', '↑', 'END', 'PGUP'],
    ['TAB', 'CTRL', 'ALT', '←', '↓', '→', 'PGDN'],
  ])
  const sent = (x: (typeof EXTRA_KEYS)[number][number], appCursor = false) =>
    'key' in x ? keyBytes([x.key], appCursor) : 'text' in x ? x.text : `mod:${x.mod}`
  expect(EXTRA_KEYS.flat().map((x) => sent(x))).toEqual([
    '\x1b', '/', '-', '\x1b[H', '\x1b[A', '\x1b[F', '\x1b[5~',
    '\t', 'mod:ctrl', 'mod:alt', '\x1b[D', '\x1b[B', '\x1b[C', '\x1b[6~',
  ])
  // in a full-screen program (application cursor mode) the arrows, HOME and END are SS3
  expect(EXTRA_KEYS.flat().filter((x) => 'key' in x && /up|down|left|right|home|end/.test(x.key) && !/page/.test(x.key)).map((x) => sent(x, true)))
    .toEqual(['\x1bOH', '\x1bOA', '\x1bOF', '\x1bOD', '\x1bOB', '\x1bOC'])
  // every name is unique: it is the button's key and what a screen reader says
  expect(new Set(EXTRA_KEYS.flat().map((x) => x.name)).size).toBe(14)
  // the bar's keys take the sticky Ctrl and Alt: CTRL then HOME, ALT then PGUP, CTRL then / or −
  const ctrl = { ctrl: true, alt: false }, alt = { ctrl: false, alt: true }
  expect(keyBytes([withMods('home', ctrl), withMods('pageup', alt), withMods('end', ctrl)], false)).toBe('\x1b[1;5H\x1b[5;3~\x1b[1;5F')
  expect(modText('/', ctrl)).toEqual([{ keys: ['ctrl+/'] }])
  expect(modText('-', alt)).toEqual([{ keys: ['alt+-'] }])
  expect(keyBytes(['alt+-'], false)).toBe('\x1b-')
  // CTRL then l on the keyboard clears
  expect(keyBytes(modText('l', ctrl).flatMap((p) => ('keys' in p ? p.keys : [])), false)).toBe('\x0c')
})
