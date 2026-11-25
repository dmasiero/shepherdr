// fork: a phone keyboard's echo of a sent message. Gboard keeps what it is still writing (a word being typed, or a whole
// phrase from its voice typing) as unfinished text; Send empties the box while that text is unfinished, and a moment later
// the keyboard finishes it, writing it back into the emptied box: the sent words come back, cursor at their end, and stay
// as the draft. Right after a send, the box takes no input that puts back (the end of) what was just sent in one go.

/** how long after a send the keyboard's echo is still expected */
export const ECHO_MS = 2_000

const sent = new Map<string, { text: string; at: number }>()

/** a box's words were just sent (key: the box's chat) */
export function sentFrom(key: string, text: string, now = Date.now()) {
  if (text.trim()) sent.set(key, { text: text.trimEnd(), at: now })
}

/** whether a change to a box is the keyboard writing back what was just sent: the box was empty, and the whole new
 *  value came in one input (data: the input event's text) and is the sent text, or its last words. Typing anything else
 *  ends the watch. */
export function isEcho(key: string, was: string, value: string, data: string | null | undefined, now = Date.now()): boolean {
  const s = sent.get(key)
  if (!s) return false
  if (now - s.at > ECHO_MS) {
    sent.delete(key)
    return false
  }
  const v = value.trim()
  const echo = !was && v.length > 1 && (data ?? '').trim() === v && (s.text === v || s.text.endsWith(` ${v}`) || s.text.endsWith(`\n${v}`))
  if (!echo) sent.delete(key)
  return echo
}
