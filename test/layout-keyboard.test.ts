// Message-local keys must not also invoke navigation behind the chat.
import { describe, expect, test } from 'bun:test'
import { layout, still } from './layout.ts'

const { browser, url } = await layout()
describe.skipIf(!browser)('chat keyboard ownership', () => {
  test('Enter on a focused message opens reactions and keeps the coordinator chat', async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    page.setDefaultTimeout(5000)
    try {
      await page.goto(url())
      const message = page.locator('[data-msg="long-agent"] [data-anchor]')
      await message.waitFor()
      // Initial lazy artifact frames can move the chat; opening reactions during
      // that scroll correctly closes the anchored bar. Wait until the message settles.
      await still(message)
      await message.focus()
      const before = page.url()
      await message.press('Enter')
      await page.locator('[role=dialog][aria-label=React]').waitFor({ state: 'visible' })
      expect(page.url()).toBe(before)
      await page.keyboard.press('Escape')
      await page.locator('[role=dialog][aria-label=React]').waitFor({ state: 'detached' })
      expect(page.url()).toBe(before)
    } finally { await page.close() }
  }, 30_000)
})
