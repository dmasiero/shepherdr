// File paths in the box (core/path-pick.js, SHEP-50): "@~/" lists the folder typed so far on the machine that runs
// this chat's agent (api/paths), folders first; Tab fills in what the matches share or takes the chosen one, a folder
// taken stays open on it, a file goes in as its plain path. As the window's.
import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { DocumentIcon, FolderIcon } from '@heroicons/react/16/solid'
import * as PPc from '@core/path-pick.js'

const P = PPc as any

export type Typed = { raw: string; dir: string; part: string }
export type Took = { path: string; open: boolean }

/* ---------- each folder's entries, kept a few seconds ---------- */

const dirs = new Map<string, { at: number; got: Promise<string[]> }>()
const known = new Map<string, string[]>()
const listeners = new Set<() => void>()

function load(chatKey: string, dir: string) {
  const k = `${chatKey}\n${dir}`, was = dirs.get(k)
  if (was && Date.now() - was.at < 5_000) return
  const got: Promise<string[]> = fetch(`api/paths?chat=${encodeURIComponent(chatKey)}&dir=${encodeURIComponent(dir)}`)
    .then((r) => r.json()).then((d) => (Array.isArray(d?.entries) ? d.entries : [])).catch(() => [])
  dirs.set(k, { at: Date.now(), got })
  void got.then((e) => { known.set(k, e); listeners.forEach((f) => f()) })
}

export const typingPath = (text: string): Typed | null => P.typingPath(text)

/** the entries for what is typed (none until its folder comes) */
export function usePaths(chatKey: string, t: Typed | null): string[] {
  const [, tick] = useState(0)
  const dir = t?.dir ?? null
  useEffect(() => {
    if (dir === null) return
    const on = () => tick((n) => n + 1)
    listeners.add(on)
    load(chatKey, dir)
    return () => void listeners.delete(on)
  }, [chatKey, dir])
  return t ? (P.matchPaths(known.get(`${chatKey}\n${t.dir}`) ?? [], t.part) as string[]) : []
}

/** Tab: the shared start, else the chosen one (moved: chosen with Up or Down) */
export const tabPath = (t: Typed, list: string[], sel: number): Took | null => P.tab(t, list, sel, sel > 0)
export const takePath = (t: Typed, entry: string): Took => P.take(t, entry)
export const pathInto = (text: string, r: Took): string => P.pathInto(text, r)

/** the list over the box: a tap (or Enter / Tab) takes one */
export function PathList({ t, items, sel, pick }: { t: Typed | null; items: string[]; sel: number; pick: (entry: string) => void }) {
  if (!t || !items.length) return null
  const at = Math.min(sel, items.length - 1)
  return (
    <div role="listbox" aria-label="Insert a file path" className="max-h-[min(22rem,40dvh)] overflow-y-auto overscroll-contain rounded-box bg-bg p-1 shadow-menu">
      <div className="truncate px-2.5 pt-1.5 pb-1 text-[0.75rem] text-fg3">{t.dir}</div>
      {items.map((e, i) => {
        const on = i === at, folder = e.endsWith('/')
        const Icon = folder ? FolderIcon : DocumentIcon
        return (
          <button key={e} type="button" role="option" aria-selected={on} data-chosen={on ? '' : undefined}
            ref={on ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
            onMouseDown={(ev) => ev.preventDefault()} onClick={() => pick(e)}
            className={clsx('flex w-full min-w-0 items-center gap-2.5 rounded-row px-2.5 py-1 text-left hover:bg-hover phone:py-1.5', on && 'bg-hover')}>
            <span className="grid w-6 shrink-0 place-items-center text-fg3 phone:w-7"><Icon className="size-3.5" aria-hidden="true" /></span>
            <span className={clsx('min-w-0 truncate', folder && 'font-medium')}>{e}</span>
          </button>
        )
      })}
    </div>
  )
}
