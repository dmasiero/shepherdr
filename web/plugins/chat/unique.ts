// fork: the chat's rows each with a key of their own (FORK.md, "Terminal view shows date labels").
// A chat that spans two of its agent's sessions joins the old log's messages to the new one's (service/live.ts
// `combined`), and a message's id is its place in its own log (core/chat-log.js `a${off}`), so the two sessions can
// give two messages the same id, and with it the same row keys (the message's own and its time line's `t:<id>`).
// React loses track of a row whose key comes twice: on the next redraw it leaves that row's element behind in the
// page, and the element stays when the chat makes way for its terminal (View as terminal), a column of stray time
// lines over a terminal squeezed to nothing. Every repeat gets its own key instead.
import { cloneElement, isValidElement, type ReactNode } from 'react'

/** the rows as they are, a repeated key made its own (`k`, then `k~2`, `k~3`), each row's element kept */
export function uniqueKeys(rows: ReactNode[]): ReactNode[] {
  const seen = new Map<string, number>()
  return rows.map((r) => {
    if (!isValidElement(r) || r.key == null) return r
    const n = (seen.get(r.key) ?? 0) + 1
    seen.set(r.key, n)
    return n === 1 ? r : cloneElement(r, { key: `${r.key}~${n}` })
  })
}
