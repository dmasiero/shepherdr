// fork: Terminal stays across spaces. Your own terminal is kept as tabs, each its shell in a space's folder on its
// machine, not tied to the space you look at: switching spaces leaves the open one showing. The Terminal row or
// Ctrl+`, while the terminal shows, adds a tab for the space you are in beside the others (Terminal again adds a tab:
// a space's second is `<space id>~2`, its own shell, "name 2"); the bar's + does it too. Closing a tab (its ✕, or
// Ctrl+D / exit in it) leaves the others; the last one closes the terminal. Hidden and shown again, the tabs are as
// they were, on the space's own tab, which is added if it has none (Terminal menu row fixes).
import type { UI } from '@client/kernel.ts'

type Tabs = Pick<UI, 'terms' | 'termAt'>

/** fork: a tab's space and its number among that space's tabs (the first has none: `<space id>`, then `~2`, `~3`)
 *  (Terminal again adds a tab) */
export function tabPlace(tab: string): { place: string; n: number } {
  const m = /^(.*)~(\d+)$/.exec(tab)
  return m ? { place: m[1], n: Number(m[2]) } : { place: tab, n: 1 }
}

/** fork: a new tab for space `at`: its first if it has none, else the lowest number free (Terminal again adds a tab) */
export function nextTab(tabs: string[], at: string): string {
  if (!tabs.includes(at)) return at
  let n = 2
  while (tabs.includes(`${at}~${n}`)) n++
  return `${at}~${n}`
}

/** the tabs to show: the kept ones whose space still exists, or (none kept, as before tabs) the space you are in */
export function tabsOf(ui: Tabs, exists: (place: string) => boolean, at: string | null): string[] {
  const kept = (ui.terms ?? []).filter((t) => exists(tabPlace(t).place))
  return kept.length || !at ? kept : [at]
}

/** the tab showing: the one picked last, else the newest */
export const activeOf = (tabs: string[], termAt: string | null) => (termAt && tabs.includes(termAt) ? termAt : (tabs[tabs.length - 1] ?? null))

/** the Terminal row (or Ctrl+`) in space `at`: while the terminal shows, another tab for this space, beside the others
 *  and picked (fork: Terminal again adds a tab; it no longer hides: the ⌄ or the drawer's close does); hidden, it
 *  shows again as it was, on this space's tab if it has one, with this space's first added when it has none (fork:
 *  Terminal menu row fixes) */
export function openIn(ui: Tabs, at: string | null, shown: boolean): Tabs & { show: boolean } {
  const tabs = ui.terms ?? []
  const active = activeOf(tabs, ui.termAt)
  if (!at) return { terms: tabs, termAt: ui.termAt, show: !shown }
  // shown with none kept (a terminal open from before tabs) shows this space's: it is the first
  if (shown) return { ...addTab({ terms: tabs.length ? tabs : [at], termAt: ui.termAt }, at), show: true }
  if (!tabs.length) return { terms: [at], termAt: at, show: true }
  const mine = tabs.filter((t) => tabPlace(t).place === at)
  // fork: hidden, with only other spaces' tabs: they show again and this space's is added beside them, so Terminal
  // always lands in a terminal for the space it was chosen in (Terminal menu row fixes)
  if (!mine.length) return { ...addTab({ terms: tabs, termAt: ui.termAt }, at), show: true }
  return { terms: tabs, termAt: active && mine.includes(active) ? active : mine[mine.length - 1], show: true }
}

/** the + in the bar (and the row while showing): a new tab for this space, its own shell, beside the others, showing */
export const addTab = (ui: Tabs, at: string): Tabs => {
  const tabs = ui.terms ?? [], tab = nextTab(tabs, at)
  return { terms: [...tabs, tab], termAt: tab }
}

/** a tab's ✕ or its shell ended: the others stay, the one next to it shows; none left closes the terminal */
export function closeTab(ui: Tabs, tabs: string[], place: string): Tabs & { show: boolean } {
  const i = tabs.indexOf(place)
  const left = tabs.filter((t) => t !== place)
  const active = activeOf(tabs, ui.termAt)
  const next = active !== place ? active : (left[Math.max(0, i - 1)] ?? null)
  return { terms: left, termAt: next, show: left.length > 0 }
}
