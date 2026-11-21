import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// fork (SHEP-83): on a touch screen the extra-keys bar is the terminal view's last row, keyboard up or down: no hint
// line ("Tap to type · pinch to zoom") and no band under it; the app's own bottom padding keeps it off the home bar
test('the touch terminal has no hint under its extra-keys bar', () => {
  const src = readFileSync(new URL('./client.tsx', import.meta.url), 'utf8')
  expect(src).not.toContain('Tap to type')
  const bar = src.slice(src.indexOf('aria-label="Extra keys"'))
  // after the bar's grid closes, the touch branch ends: nothing else is drawn under it
  expect(bar).toMatch(/^[^]*?\n {10}<\/div>\n {8}<\/>\n {6}\) : \(/)
  // the desktop hint stays
  expect(src).toContain("'Click to type' : 'Keys go to the terminal'")
})
