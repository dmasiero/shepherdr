// fork: file paths in the message box (SHEP-50, redone on 3.2; core/path-pick.js). "@~/" or "@/" lists the folder
// typed so far on the machine that runs this chat's agent (api/paths), folders first, over the box. Tab fills in what
// the matches share or takes the chosen one, Up/Down choose, Enter takes the chosen one, Escape closes it; a folder
// taken stays open on it, a file goes in as its plain path. After a take the caret is at the end of the box.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Row } from '@client/ui.tsx'
import * as PPc from '@core/path-pick.js'

const P = PPc as any

export type Typed = { raw: string; dir: string; part: string }
export type Took = { path: string; open: boolean }
export type PathKey = { sel: number; moved: boolean } | { took: Took | null } | { closed: true }

/* ---------- each folder's entries, kept a few seconds ---------- */

const dirs = new Map<string, number>()
const known = new Map<string, string[]>()
const listeners = new Set<() => void>()

/** a folder's entries for a chat, from api/paths (fetch: for tests) */
export function loadDir(chatKey: string, dir: string, f: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<void> {
  const k = `${chatKey}\n${dir}`, was = dirs.get(k)
  if (was && Date.now() - was < 5_000) return Promise.resolve()
  dirs.set(k, Date.now())
  return f(`api/paths?chat=${encodeURIComponent(chatKey)}&dir=${encodeURIComponent(dir)}`, { headers: { 'x-shepherdr': '1' } })
    .then((r) => r.json())
    .then((d: { entries?: unknown }) => (Array.isArray(d?.entries) ? (d.entries as string[]) : []))
    .catch(() => [] as string[])
    .then((e) => {
      known.set(k, e)
      listeners.forEach((l) => l())
    })
}

/** the entries for what is typed (none until its folder comes) */
export const matchesFor = (chatKey: string, t: Typed | null): string[] => (t ? (P.matchPaths(known.get(`${chatKey}\n${t.dir}`) ?? [], t.part) as string[]) : [])

export const typingPath = (text: string): Typed | null => P.typingPath(text)
export const pathInto = (text: string, r: Took): string => P.pathInto(text, r)
export const takePath = (t: Typed, entry: string): Took => P.take(t, entry)
export const pathKey = (t: Typed | null, list: string[], sel: number, moved: boolean, k: { key: string; shift: boolean; sends: boolean }): PathKey | null => P.keyOf(t, list, sel, moved, k)

/** the box's words set, then the caret at their end, the box focused (a take never leaves it at the start) */
export function setAtEnd(box: HTMLTextAreaElement | null, setText: (v: string) => void, v: string) {
  setText(v)
  if (!box) return
  box.focus()
  const end = () => box.setSelectionRange(v.length, v.length)
  end()
  requestAnimationFrame(end)
}

/** the box's path list: what it shows over the box, and its keys (onKey true: the list took the key) */
export function usePaths(chatKey: string, text: string, setText: (v: string) => void, ref: RefObject<HTMLTextAreaElement | null>) {
  const t = typingPath(text)
  const [, tick] = useState(0)
  const [closed, setClosed] = useState<string | null>(null)
  const [sel, setSel] = useState(0)
  const [moved, setMoved] = useState(false)
  const dir = t?.dir ?? null
  useEffect(() => {
    if (dir === null) return
    const on = () => tick((n) => n + 1)
    listeners.add(on)
    void loadDir(chatKey, dir)
    return () => void listeners.delete(on)
  }, [chatKey, dir])
  useEffect(() => {
    setSel(0)
    setMoved(false)
  }, [t?.dir, t?.part])
  const items = closed !== text ? matchesFor(chatKey, t) : []
  const takeTo = (r: Took | null) => r && setAtEnd(ref.current, setText, pathInto(text, r))
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, sends: boolean): boolean => {
    if (e.nativeEvent.isComposing) return false
    const r = pathKey(t, items, sel, moved, { key: e.key, shift: e.shiftKey, sends })
    if (!r) return false
    e.preventDefault()
    if ('sel' in r) {
      setSel(r.sel)
      setMoved(r.moved)
    } else if ('took' in r) takeTo(r.took)
    else setClosed(text)
    return true
  }
  const list = t && items.length ? <PathList t={t} items={items} sel={Math.min(sel, items.length - 1)} pick={(e) => takeTo(takePath(t, e))} /> : null
  return { list, onKey }
}

/** the list over the box: a tap (or Enter / Tab) takes one */
export function PathList({ t, items, sel, pick }: { t: Typed; items: string[]; sel: number; pick: (entry: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }), [sel, items])
  return (
    <div ref={box} className="ppick" role="listbox" aria-label="Insert a file path">
      <div className="cap">{t.dir}</div>
      {items.map((e, i) => {
        const on = i === sel, folder = e.endsWith('/')
        return (
          <Row
            key={e}
            role="option"
            aria-selected={on}
            current={on}
            icon={folder ? 'folder' : 'doc'}
            label={e}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => pick(e)}
          />
        )
      })}
    </div>
  )
}
