// fork: what Close on a tab in the web's tab bar does (SHEP-28). The bar always shows an Assistant tab first, also
// for a space whose Assistant isn't open (no tab in the window, no agent). Closing that one counted it out of the
// space's tabs, so with one other tab left it asked "Close “pool.fan”?" and closed the whole space: the person
// closing a broken Assistant lost the space. An Assistant that isn't open has nothing to close.
//   none: nothing to close (an Assistant tab that isn't open); assistant: the live Assistant (its workers asked about
//   first, and the space too when it is the last tab); space: the space's last tab, so the space (asked first); tab:
//   just this tab. web/plugins/coordinators/client.tsx closeTab acts on it.
export type CloseOf = 'none' | 'assistant' | 'space' | 'tab'

export const NOTHING = { title: 'Nothing to close', body: "This space's Assistant isn't open. Send it a message to start it." }

export function closeOf(tabs: { assistant: boolean }[], tab: { assistant: boolean }, open: { tab: boolean; live: boolean }): CloseOf {
  if (tab.assistant && !open.tab && !open.live) return 'none'
  const many = tabs.filter((t) => !t.assistant || open.tab || open.live).length > 1
  if (tab.assistant && open.live) return 'assistant'
  return many ? 'tab' : 'space'
}
