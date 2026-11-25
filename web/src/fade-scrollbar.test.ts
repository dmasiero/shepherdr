// fork: Fade off the scrollbar. The fade at the top of the message box's foot (it lets the chat's last lines fade
// into the box) spanned the whole column, so it dimmed the end of the scrollbar of what scrolls above it. It now
// ends beside that scrollbar: --sbw, its width, kept on the column by watchScrollbar.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { watchScrollbar } from './ui.tsx'

const ds = readFileSync(new URL('./ds.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('the fade over the foot ends at the scrollbar, in the chat and the side pane', () => {
  const rule = ds.match(/:is\(\.chat,\.pane\)>\.foot:has\(>\.cbox\)::before\{([^}]*)\}/)?.[1] ?? ''
  expect(rule).toContain('right:var(--sbw,0px)')
  expect(rule).toContain('left:0')
})

test('the column knows its scrollbar width, follows it as it changes, and forgets it when done', () => {
  const props = new Map<string, string>()
  const col = { style: { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) } }
  const el = { parentElement: col, clientWidth: 785, getBoundingClientRect: () => ({ width: 800 }) } as unknown as HTMLElement
  let fire = () => {}
  let observed: unknown = null
  let gone = false
  const g = globalThis as { ResizeObserver?: unknown }
  const was = g.ResizeObserver
  g.ResizeObserver = class {
    constructor(cb: () => void) { fire = cb }
    observe(t: unknown) { observed = t }
    disconnect() { gone = true }
  }
  try {
    const stop = watchScrollbar(el)
    expect(observed).toBe(el)
    expect(props.get('--sbw')).toBe('15px')
    // a zoom that leaves a fraction: the fade stops short of the scrollbar rather than over it
    ;(el as { clientWidth: number }).clientWidth = 784
    ;(el as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect = () => ({ width: 799.6 })
    fire()
    expect(props.get('--sbw')).toBe('16px')
    // no scrollbar (short chat, or scrollbars that float over the page): the fade spans the column as before
    ;(el as { clientWidth: number }).clientWidth = 800
    ;(el as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect = () => ({ width: 800 })
    fire()
    expect(props.get('--sbw')).toBe('0px')
    stop()
    expect(gone).toBe(true)
    expect(props.has('--sbw')).toBe(false)
  } finally {
    g.ResizeObserver = was
  }
})
