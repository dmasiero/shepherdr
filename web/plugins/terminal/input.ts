// A person's keys as the bytes a terminal sends for them. herdr-core's terminal.keys waits for a person to pause
// (about 3 s after the last typed text) before it presses anything, as `hc send` does for agents: right for an agent,
// wrong for the person typing. So the page's own keys go in as bytes on the same stream as its typed text, in order,
// with no wait. The cursor keys follow the program's cursor mode, which the page's own terminal view knows.

const CSI = '\x1b['
const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }
const TILDE: Record<string, string> = { delete: '3', pageup: '5', pagedown: '6' }
const PLAIN: Record<string, string> = { enter: '\r', esc: '\x1b', backspace: '\x7f' }
const CTRL_OTHER: Record<string, string> = { '@': '\0', ' ': '\0', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' }

/** a herdr key name's modifiers and its key: `ctrl+alt+up` is Ctrl, Alt and up; `alt++` is Alt and + */
export function parseKey(key: string) {
  const [, mods, base] = /^((?:(?:ctrl|alt|shift)\+)*)(.+)$/su.exec(key) ?? ['', '', key]
  return { ctrl: mods.includes('ctrl+'), alt: mods.includes('alt+'), shift: mods.includes('shift+'), base }
}

/** a herdr key name as a terminal's bytes (xterm's), or null when it has none here (that key goes by terminal.keys) */
function keyByte(key: string, appCursor: boolean): string | null {
  const { ctrl, alt, shift, base } = parseKey(key)
  // a cursor or paging key with modifiers: xterm's CSI 1;<1 + Shift 1, Alt 2, Ctrl 4>
  const mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
  if (CURSOR[base]) return mod > 1 ? `${CSI}1;${mod}${CURSOR[base]}` : (appCursor ? '\x1bO' : CSI) + CURSOR[base]
  if (TILDE[base]) return CSI + TILDE[base] + (mod > 1 ? `;${mod}` : '') + '~'
  // Alt is Esc first (the meta key)
  const esc = alt ? '\x1b' : ''
  if (base === 'tab') return ctrl ? null : esc + (shift ? CSI + 'Z' : '\t')
  if (shift) return null
  if (base === 'backspace' && ctrl) return esc + '\x08'
  if (PLAIN[base]) return ctrl ? null : esc + PLAIN[base]
  if (Array.from(base).length !== 1) return null
  // a bare character is text, not a key
  if (!ctrl) return alt ? esc + base : null
  const c = base.toLowerCase()
  if (/[a-z]/.test(c)) return esc + String.fromCharCode(c.charCodeAt(0) - 96)
  return CTRL_OTHER[c] === undefined ? null : esc + CTRL_OTHER[c]
}

/** herdr key names as one run of bytes, or null if any of them has none here */
export function keyBytes(keys: string[], appCursor: boolean): string | null {
  let out = ''
  for (const k of keys) {
    const b = keyByte(k, appCursor)
    if (b === null) return null
    out += b
  }
  return out
}

/** what to type for a box that held `sent` (already typed) and now holds `now`: a Backspace for each character taken
 *  back (a keyboard's correction of the word it is composing), then the new text; a newline is Enter */
export function typedDiff(sent: string, now: string): string {
  const a = Array.from(sent), b = Array.from(now)
  let same = 0
  while (same < a.length && same < b.length && a[same] === b[same]) same++
  return '\x7f'.repeat(a.length - same) + b.slice(same).join('').replace(/\r?\n/g, '\r')
}

/** The extra keys' sticky Ctrl and Alt (SHEP-23): a tap engages one for the next key only, a second tap lets it go. */
export type Mods = { ctrl: boolean; alt: boolean }
export const NO_MODS: Mods = { ctrl: false, alt: false }
export const anyMod = (m: Mods) => m.ctrl || m.alt
export const tapMod = (m: Mods, which: keyof Mods): Mods => ({ ...m, [which]: !m[which] })

/** One key of the phone's extra-keys bar: a key name (`key`), a character typed as text (`text`) or a sticky modifier
 *  (`mod`), with its label and the name a screen reader says. */
export type ExtraKey = { label: string; name: string } & ({ key: string } | { text: string } | { mod: keyof Mods })

/** fork (SHEP-26): the phone's extra-keys bar, two rows of seven as Termux's, in place of SHEP-24's one-line key row.
 *  `−` is the hyphen-minus key; Ctrl-C is the sticky Ctrl then `c`, and Enter is on the phone's keyboard. */
export const EXTRA_KEYS: ExtraKey[][] = [
  [
    { label: 'ESC', name: 'Esc', key: 'esc' },
    { label: '/', name: 'Slash', text: '/' },
    { label: '−', name: 'Minus', text: '-' },
    { label: 'HOME', name: 'Home', key: 'home' },
    { label: '↑', name: 'Up', key: 'up' },
    { label: 'END', name: 'End', key: 'end' },
    { label: 'PGUP', name: 'Page up', key: 'pageup' },
  ],
  [
    { label: 'TAB', name: 'Tab', key: 'tab' },
    { label: 'CTRL', name: 'Ctrl', mod: 'ctrl' },
    { label: 'ALT', name: 'Alt', mod: 'alt' },
    { label: '←', name: 'Left', key: 'left' },
    { label: '↓', name: 'Down', key: 'down' },
    { label: '→', name: 'Right', key: 'right' },
    { label: 'PGDN', name: 'Page down', key: 'pagedown' },
  ],
]

/** a key name with the engaged modifiers added: `up` with Ctrl is `ctrl+up`, the row's `ctrl+c` with Alt `ctrl+alt+c` */
export function withMods(key: string, m: Mods) {
  const k = parseKey(key)
  const ctrl = k.ctrl || m.ctrl
  const base = ctrl && /^[A-Z]$/.test(k.base) ? k.base.toLowerCase() : k.base
  return [ctrl && 'ctrl', (k.alt || m.alt) && 'alt', k.shift && 'shift', base].filter(Boolean).join('+')
}

/** the box's characters that are keys */
const TYPED_KEYS: Record<string, string> = { '\r': 'enter', '\t': 'tab', '\x1b': 'esc', '\x7f': 'backspace' }

/** typed text with the engaged modifiers on its first new character, in order: a keyboard's correction (its leading
 *  Backspaces) goes first as it is, then that character as a key (Ctrl then `l` is `ctrl+l`), then the rest as text */
export function modText(text: string, m: Mods): ({ keys: string[] } | { text: string })[] {
  const chars = Array.from(text)
  let i = 0
  while (chars[i] === '\x7f') i++
  if (!anyMod(m) || i === chars.length) return text ? [{ text }] : []
  const out: ({ keys: string[] } | { text: string })[] = []
  if (i) out.push({ text: chars.slice(0, i).join('') })
  out.push({ keys: [withMods(TYPED_KEYS[chars[i]] ?? chars[i], m)] })
  if (i + 1 < chars.length) out.push({ text: chars.slice(i + 1).join('') })
  return out
}
