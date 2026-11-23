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
