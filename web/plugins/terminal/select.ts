// fork: Select text in phone terminal. The maths of a finger's selection on a terminal's screen, apart from the page:
// where a finger is in the grid, the word under it, a selection's two ends, and where its handles and its menu go.
// A selection's ends are boundaries between cells (a column from 0 to cols on a buffer row, the end not included), so a
// handle sits between two characters, as a phone's text handles do.

/** a place in the terminal's buffer: a row (the buffer's, scrollback and all) and a column */
export interface Spot {
  row: number
  col: number
}

/** a selection: from `start` up to (not with) `end` */
export interface Span {
  start: Spot
  end: Spot
}

/** the screen's grid on the page: its top left corner, a cell's size, the grid and the first row showing */
export interface Grid {
  left: number
  top: number
  width: number
  height: number
  cols: number
  rows: number
  viewportY: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)

/** the cell under a point of the page (kept on the screen) */
export function cellAt(x: number, y: number, g: Grid): Spot {
  return {
    row: g.viewportY + clamp(Math.floor((y - g.top) / g.height), 0, g.rows - 1),
    col: clamp(Math.floor((x - g.left) / g.width), 0, g.cols - 1),
  }
}

/** the boundary nearest a point of the page: a handle dragged there ends the selection there */
export function edgeAt(x: number, y: number, g: Grid): Spot {
  return {
    row: g.viewportY + clamp(Math.floor((y - g.top) / g.height), 0, g.rows - 1),
    col: clamp(Math.round((x - g.left) / g.width), 0, g.cols),
  }
}

/** a comes before b */
export const before = (a: Spot, b: Spot) => a.row < b.row || (a.row === b.row && a.col < b.col)

/** two boundaries in order, at least one cell apart */
export function span(a: Spot, b: Spot, cols: number): Span {
  const [start, end] = before(b, a) ? [b, a] : [a, b]
  if (start.row === end.row && start.col === end.col) return start.col < cols ? { start, end: { row: end.row, col: end.col + 1 } } : { start: { row: start.row, col: start.col - 1 }, end }
  return { start, end }
}

/** xterm's select(col, row, length): the cells from start to end, rows counted whole in between */
export function toSelect(s: Span, cols: number): [number, number, number] {
  return [s.start.col, s.start.row, Math.max(1, (s.end.row - s.start.row) * cols + s.end.col - s.start.col)]
}

/** what ends a word: spaces, brackets, quotes and a box's sides. Paths and addresses (/ . - _ : ~ @ = + #) stay whole,
 *  and so does an apostrophe between two letters (didn't). */
const SEP = /[\s()[\]{}<>'"`,;|│┃─━]/
const LETTER = /[\p{L}\p{N}]/u

/** the word under a cell, as columns from..to (not with). `cells` holds each cell's character: '' for the second half
 *  of a wide one, ' ' for an empty cell. A space or a separator is a word of one cell. */
export function wordAt(cells: string[], col: number): { from: number; to: number } {
  const sep = (i: number) => cells[i] !== '' && SEP.test(cells[i] || ' ') && !(cells[i] === "'" && LETTER.test(cells[i - 1] ?? '') && LETTER.test(cells[i + 1] ?? ''))
  let c = col
  // the second half of a wide character belongs to its first
  while (c > 0 && cells[c] === '') c--
  if (sep(c)) return { from: c, to: c + 1 }
  let from = c, to = c + 1
  while (from > 0 && !sep(from - 1)) from--
  while (to < cells.length && !sep(to)) to++
  return { from, to }
}

/** a long press's selection stretched toward where the finger has moved: the word it started on stays in it */
export function stretch(word: Span, finger: Spot, cols: number): Span {
  if (before(finger, word.start)) return { start: finger, end: word.end }
  if (before(word.end, finger)) return span(word.start, finger, cols)
  return word
}

/** a handle being dragged to a new boundary: the other end stays; dragged over it, the handle becomes the other end */
export function dragEnd(s: Span, which: 'start' | 'end', to: Spot, cols: number): { span: Span; which: 'start' | 'end' } {
  const fixed = which === 'start' ? s.end : s.start
  return { span: span(fixed, to, cols), which: before(to, fixed) ? 'start' : 'end' }
}

/** an end at a row's first column is drawn at the end of the row before (where the selection's last character is) */
export function shownEnd(end: Spot, cols: number): Spot {
  return end.col === 0 && end.row > 0 ? { row: end.row - 1, col: cols } : end
}

/** a boundary's point on the page, at the foot of its row; null when its row is out of sight */
export function pointOf(at: Spot, g: Grid): { x: number; y: number } | null {
  const r = at.row - g.viewportY
  if (r < 0 || r >= g.rows) return null
  return { x: g.left + at.col * g.width, y: g.top + (r + 1) * g.height }
}

/** some of the selection is on the screen's rows */
export const seen = (s: Span, g: Grid) => s.start.row < g.viewportY + g.rows && shownEnd(s.end, g.cols).row >= g.viewportY

/** where the menu goes, in a box `w` by `h` (the terminal's own): above the selection's first row where it fits,
 *  else below its last (under the handles, `below` px), else over the middle of the box; kept inside sideways */
export function menuAt(s: Span, g: Grid, box: { width: number; height: number }, menu: { width: number; height: number }, below = 28): { left: number; top: number } {
  const top = g.top + (s.start.row - g.viewportY) * g.height
  const foot = g.top + (shownEnd(s.end, g.cols).row - g.viewportY + 1) * g.height
  const oneRow = s.start.row === shownEnd(s.end, g.cols).row
  const mid = oneRow ? g.left + ((s.start.col + shownEnd(s.end, g.cols).col) / 2) * g.width : g.left + (g.cols / 2) * g.width
  const left = clamp(mid - menu.width / 2, 8, Math.max(8, box.width - menu.width - 8))
  if (top - menu.height - 8 >= 0 && top < box.height) return { left, top: top - menu.height - 8 }
  if (foot + below + menu.height + 8 <= box.height && foot > 0) return { left, top: foot + below }
  return { left, top: clamp((box.height - menu.height) / 2, 0, Math.max(0, box.height - menu.height)) }
}

/** a touch moved this far (px) is a swipe, not a tap or a hold */
export const SLOP = 10
