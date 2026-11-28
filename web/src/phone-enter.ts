// fork: Enter sends on phone (Settings › General › Message box), kept on this device only and on until turned off:
// today's Enter sends, Shift+Enter adds a new line. Android's on-screen keyboards (Gboard) never send Shift with their
// Enter key, so on a phone that left no way to add a line. Off, on a touch-only device (no mouse or trackpad anywhere:
// enter.ts's touchOnly, the same test before the keyboard comes up, so its return key shows the right thing), Enter
// adds a new line, the return key shows a return, and the Send button sends (Ctrl/Cmd+Enter too, from a keyboard
// plugged in). A computer and a tablet with a trackpad send on Enter as before, whatever it says.
import { useSyncExternalStore } from 'react'
import { touchOnly } from './enter.ts'

/** localStorage: '0' when turned off, nothing when on (the default) */
export const KEY = 'shepherdr.enterSends'

let on = true
try {
  on = typeof localStorage === 'undefined' || localStorage.getItem(KEY) !== '0'
} catch {}
const listeners = new Set<() => void>()

export function setEnterSends(v: boolean) {
  on = v
  try {
    if (v) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, '0')
  } catch {
    /* a private window: until it closes */
  }
  for (const l of listeners) l()
}

if (typeof addEventListener === 'function') addEventListener('storage', (e: StorageEvent) => e.key === KEY && setEnterSends(e.newValue !== '0'))

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** the switch: Enter sends on this device */
export const useEnterSends = () => useSyncExternalStore(subscribe, () => on, () => true)

/** this device has the switch: a computer always sends on Enter */
export const hasEnterSwitch = touchOnly

/** Enter adds a new line here: the switch off on a touch-only device */
export const enterLines = (sends: boolean, touch: boolean) => !sends && touch

export type BoxKey = { key: string; shiftKey: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }

/** Does this key send from the message box? Never Shift+Enter, never while an IME composes a word (isComposing, or
 *  Android's keyCode 229). Where Enter adds a new line (lines), only Ctrl/Cmd+Enter sends; else Enter does. */
export function boxSends(e: BoxKey, lines: boolean): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return false
  return !lines || !!e.ctrlKey || !!e.metaKey
}

/** the return key's label on an on-screen keyboard */
export const boxHint = (lines: boolean): 'enter' | 'send' => (lines ? 'enter' : 'send')
