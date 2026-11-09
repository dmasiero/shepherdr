import type { Place } from '@shared/types.ts'
import { tabInChat } from './shown.ts'

/**
 * fork: whether a space tab's terminal (`term` = t:<terminal>) shows in place of the chat `chatKey` (SHEP-27).
 * Only the space column that owns the tab, which still passes its Assistant's chat key, shows it; a task panel's chat
 * or any other chat keeps its own conversation. A tab switched to Chat shows its own chat instead (upstream's tabInChat).
 */
export function tabTermFor(term: string | null | undefined, tabView: Record<string, 'chat' | 'terminal'> | undefined, chatKey: string, places: Place[]) {
  if (!term?.startsWith('t:') || tabInChat({ tabView }, term)) return false
  return places.some((p) => p.chat === chatKey && !!p.tabs?.some((t) => t.term === term))
}
