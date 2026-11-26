import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { snapshot } from '../../demo/data.ts'

// fork: Jump arrow in side pane. A task's chat in the side pane showed no round ↓ (upstream #1504's jump to the newest
// message): its pane drew only the box at its foot, never the above-box views. The ones meant for the pane (`pane`)
// now go over its box as in the middle column; the rest (the warnings line) stay the middle column's.

mock.module('@plugins/chat/markdown.tsx', () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, toHtml: (t: string) => t, linked: (t: string) => t, withLinks: (t: string) => [t] }))
const { getState, registry, setUI } = await import('@client/kernel.ts')
const tasks = (await import('./client.tsx')).default
const { OFF_PX } = await import('@plugins/chat/newest.ts')

test("a task's chat in the side pane has the jump to the newest message above its box, and not the warnings line", () => {
  tasks.setup(registry)
  registry.views.box = () => <div className="cbox">BOX</div>
  registry.aboveBox.push({ order: 5, View: () => <button type="button" className="toend">JUMP</button>, pane: true }, { order: 10, View: () => <div>WARNINGS</div> })
  Object.assign(getState(), { snap: snapshot() })
  setUI({ pane: 'tasks', task: 'SHOP-15' })
  const P = registry.panes.find((p) => p.id === 'tasks')!.View
  const html = renderToStaticMarkup(<P />)
  const foot = html.slice(html.indexOf('class="foot"'))
  expect(foot).toContain('JUMP')
  expect(foot.indexOf('JUMP')).toBeLessThan(foot.indexOf('BOX'))
  expect(html).not.toContain('WARNINGS')
})

test("the fork's distance: the button shows once the chat stops following its end (80px), not upstream's 240", () => {
  expect(OFF_PX).toBe(80)
})
