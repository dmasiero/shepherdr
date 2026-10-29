import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { artifactChecker, titleCase } from '../server/artifact-check.ts'

test('screenshots alone cannot pass validation without the explicit browser result', async () => {
  const home = mkdtempSync(join(tmpdir(), 'shep-art-check-'))
  try {
    const check = artifactChecker(home, async args => {
      for (const arg of args) if (arg.startsWith('screenshot ')) writeFileSync(arg.slice(11), 'test picture')
      return { ok: true, out: 'wrong output format', err: '' }
    }, html => html)
    expect((await check('<p>Example</p>')).errors).toContain('The browser did not return its validation result')
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('task proof titles retain case with a core-qualified task ID', () => {
  expect(titleCase('probe/REMO-1: proof')).toBe('probe/REMO-1: Proof')
  expect(titleCase('SHE-301: proof')).toBe('SHE-301: Proof')
})
