// A person's keys as the bytes a terminal sends for them. herdr-core's terminal.keys waits for a person to pause
// (about 3 s after the last typed text) before it presses anything, as `hc send` does for agents: right for an agent,
// wrong for the person typing. So the page's own keys go in as bytes on the same stream as its typed text, in order,
// with no wait. The cursor keys follow the program's cursor mode, which the page's own terminal view knows.

const CSI = '\x1b['

/** a herdr key name as a terminal's bytes, or null when it has none here (that key goes by terminal.keys) */
function keyByte(key: string, appCursor: boolean): string | null {
  const cursor = (c: string) => (appCursor ? '\x1bO' : CSI) + c
  switch (key) {
    case 'enter': return '\r'
    case 'esc': return '\x1b'
    case 'tab': return '\t'
    case 'shift+tab': return CSI + 'Z'
    case 'backspace': return '\x7f'
    case 'delete': return CSI + '3~'
    case 'up': return cursor('A')
    case 'down': return cursor('B')
    case 'right': return cursor('C')
    case 'left': return cursor('D')
    case 'home': return cursor('H')
    case 'end': return cursor('F')
    case 'pageup': return CSI + '5~'
    case 'pagedown': return CSI + '6~'
  }
  const ctrl = /^ctrl\+(.)$/.exec(key)?.[1]
  if (ctrl) {
    if (/[a-z]/.test(ctrl)) return String.fromCharCode(ctrl.charCodeAt(0) - 96)
    const other: Record<string, string> = { '@': '\0', ' ': '\0', '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '_': '\x1f', '?': '\x7f' }
    return other[ctrl] ?? null
  }
  const alt = /^alt\+(.)$/u.exec(key)?.[1]
  if (alt) return '\x1b' + alt
  return null
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
