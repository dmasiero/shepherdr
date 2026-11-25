// fork: Night, true black for OLED (FORK.md). The theme picked puts data-theme="night" on the page and counts as dark
// everywhere dark is asked; its bars and manifest are black; every text and status colour reads on black and on each
// raised grey it sits on.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('Night sets data-theme night, counts as dark, and paints the bars and the manifest black', async () => {
  const g = globalThis as any
  const was = { document: g.document, localStorage: g.localStorage, matchMedia: g.matchMedia, addEventListener: g.addEventListener }
  const store = new Map<string, string>([['shepherdr.prefs', JSON.stringify({ theme: 'Night' })]])
  const bars = [{ content: '#ffffff' }, { content: '#121212' }]
  const manifest = { href: 'manifest.webmanifest', setAttribute(_: string, v: string) { this.href = v } }
  const root = { dataset: {} as Record<string, string>, style: { setProperty() {} } }
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
  g.matchMedia = () => ({ matches: false, addEventListener() {} })
  g.addEventListener = () => {}
  g.document = {
    documentElement: root,
    querySelectorAll: () => bars,
    querySelector: () => manifest,
  }
  try {
    const p = await import(`./prefs.ts?night=${Date.now()}`)
    expect(p.THEMES).toContain('Night')
    expect(root.dataset.theme).toBe('night')
    expect(p.isNight()).toBe(true)
    expect(p.isDark()).toBe(true)
    expect(bars.map((b) => b.content)).toEqual(['#000000', '#000000'])
    expect(manifest.href).toBe('manifest-night.webmanifest')
    // back to Dark: dark, not Night, its own grey bars
    p.setPref('theme', 'Dark')
    expect(root.dataset.theme).toBe('dark')
    expect([p.isNight(), p.isDark()]).toEqual([false, true])
    expect(bars[0]!.content).toBe('#121212')
    expect(manifest.href).toBe('manifest.webmanifest')
    expect(JSON.parse(store.get('shepherdr.prefs')!).theme).toBe('Dark')
  } finally {
    Object.assign(g, was)
  }
})

test("index.html puts Night on the page before the first paint: black, dark, its bars and manifest", () => {
  const html = read('../index.html')
  expect(html).toContain('html[data-theme="night"]{color-scheme:dark;background:#000000}')
  expect(html).toContain("var night = t === 'Night'")
  expect(html).toContain("var dark = t === 'Dark' || night ||")
  expect(html).toContain("night ? '#000000' : dark ? '#121212' : '#ffffff'")
  expect(html).toContain("if (night) document.querySelector('link[rel=manifest]').setAttribute('href', 'manifest-night.webmanifest')")
  const m = JSON.parse(read('../public/manifest-night.webmanifest'))
  expect([m.background_color, m.theme_color]).toEqual(['#000000', '#000000'])
})

/* ---------- contrast over Night's tokens (WCAG 2) ---------- */

const ds = read('./ds.css').replace(/\/\*[\s\S]*?\*\//g, '')
const night = ds.split('\n').find((l) => l.startsWith(':root[data-theme="night"]{'))!
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const full = (h: string) => (h.length === 4 ? '#' + [...h.slice(1)].map((c) => c + c).join('') : h)
const lum = (h: string) => {
  const [r, gg, b] = rgb(h).map((c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * gg! + 0.0722 * b!
}
const contrast = (a: string, b: string) => {
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y)
  return (hi! + 0.05) / (lo! + 0.05)
}
const hex = (n: number) => n.toString(16).padStart(2, '0')
/** a token as the browser paints it over the canvas: a hex, or a see-through white over black */
const tok = (name: string, under = '#000000') => {
  const v = night.match(new RegExp(`--${name}:([^;}]+)`))![1]!
  if (v.startsWith('#')) return full(v)
  const a = Number(v.match(/rgb\(255 255 255\/(\.\d+)\)/)![1])
  return '#' + rgb(under).map((c) => hex(Math.round(c + (255 - c) * a))).join('')
}

const nightPairs = () => {
  const surfaces: Record<string, string> = {
    canvas: tok('canvas'), well: tok('well'), raised: tok('raised'), overlay: tok('overlay'), mine: tok('mine'), rx: tok('rx'),
    'control (hover)': tok('control'), 'control2 (selected)': tok('control2'), term: tok('term'),
  }
  const texts = ['fg', 'sub', 'muted', 'link', 'green', 'amber', 'red', 'blue']
  return Object.entries(surfaces).flatMap(([s, bg]) => texts.map((t) => ({ text: t, on: s, ratio: contrast(tok(t), bg) })))
}

test('Night: the canvas, the side bar and the terminal are true black', () => {
  expect([tok('canvas'), tok('well'), tok('term')]).toEqual(['#000000', '#000000', '#000000'])
  expect(night).toContain('color-scheme:dark')
})

test('Night: every text and status colour reads on black and on each raised grey (4.5:1 or more)', () => {
  const pairs = nightPairs()
  if (process.env.NIGHT_TABLE) console.log(JSON.stringify(pairs.map((p) => ({ ...p, ratio: Math.round(p.ratio * 100) / 100 }))))
  for (const p of pairs) expect(`${p.text} on ${p.on}: ${p.ratio >= 4.5}`).toBe(`${p.text} on ${p.on}: true`)
})

test('Night: raised greys and lines stand apart from black (bubbles, menus, the lines between)', () => {
  // no text: a surface only needs to be seen apart from black; the lines a bit stronger than Dark's .08/.12
  for (const s of ['raised', 'overlay', 'mine', 'rx']) expect(contrast(tok(s), '#000000')).toBeGreaterThan(1.15)
  expect(contrast(tok('mine'), tok('raised'))).toBeGreaterThan(1.1)
  expect(contrast(tok('line2'), '#000000')).toBeGreaterThan(contrast(tok('line'), '#000000'))
  const a = (n: string) => Number(night.match(new RegExp(`--${n}:rgb\\(255 255 255/(\\.\\d+)\\)`))![1])
  expect(a('line')).toBeGreaterThan(0.08)
  expect(a('line2')).toBeGreaterThan(0.12)
})
