// fork: Fade off the scrollbar. The fade above the message box's foot (the chat's last lines fade into the box) was a
// layer of the canvas over the whole column: it dimmed the end of the scrollbar, and at some zooms its see-through
// canvas rounded a level off the canvas (a band). It is now a mask on what scrolls, leaving the scrollbar's strip out
// (--sbw, its width, kept on the column by watchScrollbar).
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { watchScrollbar } from './ui.tsx'

const ds = readFileSync(new URL('./ds.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

test('the fade over the foot is a mask on what scrolls, its scrollbar left out, with no layer over the canvas', () => {
  const rule = ds.match(/:is\(\.chat,\.pane\):has\(>\.foot>\.cbox\)[^{]*>\.scroll\{([^}]*)\}/)?.[1] ?? ''
  expect(rule).toContain('mask:var(--fade)')
  expect(rule).toContain('-webkit-mask:var(--fade)')
  // the scrollbar's strip, fully shown, then the 16px fade above the foot
  expect(rule).toContain('linear-gradient(#000 0 0) right top/var(--sbw,0px) 100% no-repeat')
  expect(rule).toContain('linear-gradient(to bottom,#000 calc(100% - 16px),transparent)')
  // a see-through canvas over the canvas rounds a level off it at some zooms (a band in dark): never again
  expect(ds).not.toMatch(/\.foot[^{]*::before\{[^}]*linear-gradient\([^)]*var\(--canvas\)/)
  // not over a terminal, nor a live view in full screen
  expect(ds).toMatch(/:not\(:has\(>\.scroll>\.msgs>\.tw\)\):not\(:has\(>\.scroll \.scrfull\)\)>\.scroll\{/)
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
