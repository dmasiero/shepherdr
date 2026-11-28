// fork: Select text in phone terminal. A finger's selection on a terminal, over xterm: xterm keeps and draws the
// selection itself (in its buffer, so it stays on its text while new output arrives and moves up with it), this finds
// the word under a long press, stretches it as the finger moves, moves an end with a handle, and says where the two
// handles and the menu go. xterm never sees a pointer here (the box over it takes them all), so its own mouse
// selection never runs.
import type { Terminal } from '@xterm/xterm'
import { cellAt, dragEnd, edgeAt, menuAt, pointOf, seen, shownEnd, span, stretch, toSelect, wordAt, type Grid, type Span } from './select.ts'

type Core = { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } } } }

/** where the handles and the menu go, in px inside the terminal's own box (`.tw`); null for one out of sight */
export interface SelView {
  start: { x: number; y: number } | null
  end: { x: number; y: number } | null
  /** null while a finger is still choosing */
  menu: { left: number; top: number } | null
}

export interface SelectLayer {
  /** a long press here: the word under it is selected; false when the point is off the screen's grid */
  hold(x: number, y: number): boolean
  /** the finger that held moved here: the selection stretches to it */
  stretch(x: number, y: number): void
  /** a finger took a handle */
  grab(which: 'start' | 'end', x: number, y: number): void
  /** the handle's finger moved here */
  drag(x: number, y: number): void
  /** the finger is up: the menu shows */
  release(): void
  /** everything the terminal has: the screen and its history */
  all(): void
  text(): string
  active(): boolean
  clear(): void
  /** place the handles and the menu again (the menu's size is known now) */
  refresh(): void
  dispose(): void
}

export function selectLayer(term: Terminal, wrap: HTMLElement, box: HTMLElement, show: (v: SelView | null) => void, menuSize: () => { width: number; height: number }): SelectLayer {
  const core = (term as unknown as Core)._core
  const screen = term.element!.querySelector<HTMLElement>('.xterm-screen')!
  /** the word a long press started on, while its finger is down */
  let word: Span | null = null
  let grabbed: { which: 'start' | 'end'; dy: number } | null = null
  let busy = false
  let last = ''

  const grid = (): Grid => {
    const s = screen.getBoundingClientRect()
    const w = wrap.getBoundingClientRect()
    const c = core?._renderService?.dimensions?.css?.cell
    const cell = c && c.width > 0 && c.height > 0 ? c : { width: s.width / term.cols || 8, height: s.height / term.rows || 17 }
    return { left: s.left - w.left, top: s.top - w.top, width: cell.width, height: cell.height, cols: term.cols, rows: term.rows, viewportY: term.buffer.active.viewportY }
  }
  const local = (x: number, y: number) => {
    const w = wrap.getBoundingClientRect()
    return { x: x - w.left, y: y - w.top }
  }
  const current = (): Span | null => {
    const p = term.getSelectionPosition()
    return p ? { start: { row: p.start.y, col: p.start.x }, end: { row: p.end.y, col: p.end.x } } : null
  }
  const set = (s: Span) => term.select(...toSelect(s, term.cols))

  const place = () => {
    const s = current()
    if (!s) {
      if (last) show(null)
      last = ''
      return
    }
    const g = grid()
    // the box shows only part of an agent's tall screen: a handle scrolled out of it hides
    const b = box.getBoundingClientRect(), w = wrap.getBoundingClientRect()
    const inBox = (p: { x: number; y: number } | null) => (p && p.y > b.top - w.top && p.y <= b.bottom - w.top + 1 ? p : null)
    const v: SelView = {
      start: inBox(pointOf(s.start, g)),
      end: inBox(pointOf(shownEnd(s.end, g.cols), g)),
      // scrolled out of sight, its menu waits until it is back
      menu: busy || !seen(s, g) ? null : menuAt(s, g, { width: w.width, height: b.bottom - w.top }, menuSize()),
    }
    const key = JSON.stringify(v)
    if (key === last) return
    last = key
    show(v)
  }

  const cells = (row: number) => {
    const l = term.buffer.active.getLine(row)
    const out: string[] = []
    for (let x = 0; x < term.cols; x++) {
      const c = l?.getCell(x)
      out.push(!c ? ' ' : c.getWidth() === 0 ? '' : c.getChars() || ' ')
    }
    return out
  }

  // anywhere else on the page, a press clears it; on the terminal itself the box over it decides (a tap clears, a
  // swipe scrolls and keeps it)
  const away = (e: PointerEvent) => {
    if (!(e.target instanceof Node) || !wrap.contains(e.target)) term.clearSelection()
  }
  document.addEventListener('pointerdown', away, true)
  const subs = [term.onSelectionChange(place), term.onRender(place), term.onScroll(place), term.onResize(place)]
  box.addEventListener('scroll', place, { passive: true })

  return {
    hold(x, y) {
      const g = grid(), p = local(x, y)
      if (p.x < g.left || p.y < g.top || p.x >= g.left + g.cols * g.width || p.y >= g.top + g.rows * g.height) return false
      const at = cellAt(p.x, p.y, g)
      const w = wordAt(cells(at.row), at.col)
      word = { start: { row: at.row, col: w.from }, end: { row: at.row, col: w.to } }
      busy = true
      set(word)
      return true
    },
    stretch(x, y) {
      if (!word) return
      const p = local(x, y), g = grid()
      set(stretch(word, edgeAt(p.x, p.y, g), g.cols))
    },
    grab(which, x, y) {
      const s = current(), g = grid()
      if (!s) return
      const end = which === 'start' ? s.start : shownEnd(s.end, g.cols)
      // the finger holds the handle under the row: keep that gap, so the end follows the row the finger points at
      const at = pointOf(end, g)
      grabbed = { which, dy: at ? local(x, y).y - (at.y - g.height / 2) : 0 }
      busy = true
      place()
    },
    drag(x, y) {
      const s = current()
      if (!grabbed || !s) return
      const p = local(x, y), g = grid()
      const n = dragEnd(s, grabbed.which, edgeAt(p.x, p.y - grabbed.dy, g), g.cols)
      // crossing over the other end, this handle becomes the other one
      grabbed = { ...grabbed, which: n.which }
      set(n.span)
    },
    release() {
      word = null
      grabbed = null
      busy = false
      last = ''
      place()
    },
    all() {
      busy = false
      term.selectAll()
    },
    text: () => term.getSelection(),
    active: () => term.hasSelection(),
    clear() {
      word = null
      grabbed = null
      busy = false
      term.clearSelection()
    },
    refresh() {
      last = ''
      place()
    },
    dispose() {
      document.removeEventListener('pointerdown', away, true)
      box.removeEventListener('scroll', place)
      subs.forEach((s) => s.dispose())
    },
  }
}
