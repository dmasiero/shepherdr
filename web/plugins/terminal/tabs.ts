// fork: Terminal stays across spaces. Your own terminal is kept as tabs, one per space (its shell in that space's
// folder on its machine), not tied to the space you look at: switching spaces leaves the open one showing. The
// Terminal row or Ctrl+` in a space with no tab yet, while the terminal shows, adds that space's tab beside the
// others; the bar's + does it too. Closing a tab (its ✕, or Ctrl+D / exit in it) leaves the others; the last one
// closes the terminal. Hidden and shown again, the tabs are as they were.
import type { UI } from '@client/kernel.ts'

type Tabs = Pick<UI, 'terms' | 'termAt'>

/** the tabs to show: the kept ones whose space still exists, or (none kept, as before tabs) the space you are in */
export function tabsOf(ui: Tabs, exists: (place: string) => boolean, at: string | null): string[] {
  const kept = (ui.terms ?? []).filter(exists)
  return kept.length || !at ? kept : [at]
}

/** the tab showing: the one picked last, else the newest */
export const activeOf = (tabs: string[], termAt: string | null) => (termAt && tabs.includes(termAt) ? termAt : (tabs[tabs.length - 1] ?? null))

/** the Terminal row (or Ctrl+`) in space `at`: hide it when this space's tab already shows; otherwise show it, adding
 *  this space's tab when it shows already (you start another) or when there is none yet; shown again from hidden it
 *  comes back as it was, on this space's tab if it has one (the + starts one for this space) */
export function openIn(ui: Tabs, at: string | null, shown: boolean): Tabs & { show: boolean } {
  const tabs = ui.terms ?? []
  const active = activeOf(tabs, ui.termAt)
  if (!at) return { terms: tabs, termAt: ui.termAt, show: !shown }
  if (shown && (active === at || !tabs.length)) return { terms: tabs, termAt: ui.termAt, show: false }
  if (shown || !tabs.length) return { terms: tabs.includes(at) ? tabs : [...tabs, at], termAt: at, show: true }
  return { terms: tabs, termAt: tabs.includes(at) ? at : active, show: true }
}

/** the + in the bar: a tab for this space, beside the others, showing */
export const addTab = (ui: Tabs, at: string): Tabs => ({ terms: (ui.terms ?? []).includes(at) ? ui.terms : [...(ui.terms ?? []), at], termAt: at })

/** a tab's ✕ or its shell ended: the others stay, the one next to it shows; none left closes the terminal */
export function closeTab(ui: Tabs, tabs: string[], place: string): Tabs & { show: boolean } {
  const i = tabs.indexOf(place)
  const left = tabs.filter((t) => t !== place)
  const active = activeOf(tabs, ui.termAt)
  const next = active !== place ? active : (left[Math.max(0, i - 1)] ?? null)
  return { terms: left, termAt: next, show: left.length > 0 }
}
