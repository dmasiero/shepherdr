import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { PathList, setAtEnd, typingPath } from './paths.tsx'

// fork: SHEP-50's "@~/" list over the message box, redone on 3.2 (service/chat-path-pick.test.ts walks its keys).

test('the list: the folder typed so far, then its entries, a folder with its icon, the chosen one marked', () => {
  const html = renderToStaticMarkup(<PathList t={typingPath('@~/dev/')!} items={['shop/', 'todo.md']} sel={1} pick={() => {}} />)
  expect(html).toContain('role="listbox"')
  expect(html).toContain('aria-label="Insert a file path"')
  expect(html).toContain('<div class="cap">~/dev/</div>')
  const rows = [...html.matchAll(/<button[^>]*role="option"[^>]*aria-selected="(\w+)"[^>]*>(.*?)<\/button>/g)].map((m) => [m[1], m[2]!.replace(/<[^>]*>/g, '')])
  expect(rows).toEqual([['false', 'shop/'], ['true', 'todo.md']])
})

test('after a take (Tab, Enter or a tap) the caret is at the end of the box, not its start', () => {
  let words = '', frames: (() => void)[] = []
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = ((f: () => void) => (frames.push(f), 0)) as typeof requestAnimationFrame
  try {
    // as a browser's: a new value from React leaves the caret where the page puts it; setSelectionRange moves it
    const box = { caret: 0, focused: false, focus() { this.focused = true }, setSelectionRange(a: number) { this.caret = a } }
    setAtEnd(box as unknown as HTMLTextAreaElement, (v) => { words = v; box.caret = 0 }, 'look at ~/dev/todo.md ')
    expect(words).toBe('look at ~/dev/todo.md ')
    expect(box).toMatchObject({ focused: true, caret: words.length })
    box.caret = 0 // React's render after the set
    frames.forEach((f) => f())
    expect(box.caret).toBe(words.length)
  } finally {
    globalThis.requestAnimationFrame = raf
  }
})

test("the box hands its keys to the list first, and shows it over itself", () => {
  const box = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
  expect(box).toContain('const paths = usePaths(key, text, setText, ref)')
  expect(box).toContain("if (paths.onKey(e, e.key === 'Enter' && !e.shiftKey && e.keyCode !== 229)) return")
  expect(box).toContain('{paths.list /* fork: SHEP-50 (before the replies, which hide once the box has words) */}')
})

test("no effect of the list returns a value: a newer Chrome's scrollIntoView gives a promise, which blanked the page", () => {
  const src = readFileSync(new URL('./paths.tsx', import.meta.url), 'utf8')
  expect(src).not.toMatch(/useEffect\(\(\) => [^{]/)
})
