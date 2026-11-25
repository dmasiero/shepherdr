// fork: Jump to bottom: scrolled up in a chat, a round arrow above the box leads back to its newest message, with a
// badge counting the messages that came while you were up. The app's scroll bars are hidden (ds.css).
import { useSyncExternalStore } from 'react'

export interface Jump {
  /** the button shows */
  show: boolean
  /** messages from others that came while you were up */
  fresh: number
}

export const NONE: Jump = { show: false, fresh: 0 }

/** how far from the end still counts as at it: the chat follows new messages there (client.tsx's `stuck`) */
export const AT_END = 80

/** The button shows once you are more than about three quarters of a screen up from the newest message, or any
 *  distance up once something new came. `dist` is how far the chat's end is below its window, `view` the window. */
export function jumpOf(dist: number, view: number, fresh: number): Jump {
  if (dist < AT_END) return NONE
  return dist > Math.max(200, view * 0.75) || fresh > 0 ? { show: true, fresh } : NONE
}

/** what counts: a message from someone else (not yours, not a turn's tool steps) */
interface Counted {
  who: string
  at?: number
  activity?: unknown
}
const counts = (m: Counted) => m.who !== 'you' && !m.activity

/** the newest counted message's time: where "new" starts when you leave the end */
export const newestAt = (msgs: Counted[]) => msgs.reduce((n, m) => (counts(m) && m.at ? Math.max(n, m.at) : n), 0)

/** the counted messages newer than `since`; earlier pages loaded as you scroll up are older, so they never count */
export const freshSince = (msgs: Counted[], since: number) => msgs.filter((m) => counts(m) && (m.at ?? 0) > since).length

/** the badge's words */
export const badge = (n: number) => (n <= 0 ? '' : n > 99 ? '99+' : String(n))

const now = new Map<string, Jump>()
const fns = new Set<() => void>()

/** what the chat's button shows now; the same answer keeps the same object, so nothing draws again */
export function setJump(chat: string, j: Jump) {
  const was = now.get(chat) ?? NONE
  if (was.show === j.show && was.fresh === j.fresh) return
  now.set(chat, j.show ? j : NONE)
  for (const fn of fns) fn()
}

export const jumpNow = (chat: string) => now.get(chat) ?? NONE

export function useJump(chat: string): Jump {
  return useSyncExternalStore(
    (fn) => (fns.add(fn), () => void fns.delete(fn)),
    () => jumpNow(chat),
  )
}
