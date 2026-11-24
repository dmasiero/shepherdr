// fork: Terminal size keeps flipping. One terminal open on two screens (a phone and a desktop) has one size, and only
// the screen you last used sets it: typing, a tap or a click on it, its key row, or opening it while that window is in
// front. Every other page showing the same terminal never asks for a size: it shrinks the one it is given to fit (and
// pans when that would be under 8 px). Before, every page asked for its own pane's size whenever it refitted, and a
// page shown another's size refits with a smaller font (other cell widths, a scrollbar coming or going), so the two
// kept taking the size from each other several times a second.

/** how long a page's own ask may take to come back as the terminal's size: a size from before it is no takeover */
export const ASK_WAIT = 1500

/** a size the terminal now has, told to a page that held it: does it still hold it? It lets go when the terminal
 *  moved to a size it didn't ask for (another screen took it), unless its own ask is still on the way. */
export function stillHolds(held: boolean, size: string, asked: string, askedAt: number, now: number) {
  return held && (size === asked || now - askedAt < ASK_WAIT)
}

/** a page asks for a size only while it holds the terminal and is the window in front: a hidden or background tab never */
export function mayAsk(held: boolean, doc: { visibilityState: string; hasFocus(): boolean } | null = typeof document === 'undefined' ? null : document) {
  return held && !!doc && doc.visibilityState === 'visible' && doc.hasFocus()
}
