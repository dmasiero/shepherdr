#!/usr/bin/env bun
import { readCredential } from '../server/core/home.ts'
import { coreRequest } from '../server/core/request.ts'
import type { MailCredential } from '../server/core/envelope.ts'

try {
  const path = process.env.SHEPHERDR_CORE_CREDENTIAL
  if (!path) throw new Error('No authenticated core session. Run this command from its owning Shepherdr agent.')
  const credential = readCredential<{ mail: MailCredential; socket: string }>(path)
  const args = process.argv.slice(2)
  if (args.includes('--url')) throw new Error('Core agents use their owning core mailbox, not a web URL')
  const result = await coreRequest(credential.socket, credential.mail, 'cli', { args, cwd: process.cwd() }, {
    timeout: args[0] === 'merge' || args[0] === 'checks' ? 110_000 : 60_000,
  }) as { out: string; code: number }
  process.stdout.write(result.out)
  process.exitCode = result.code
} catch (error) { console.error((error as Error).message); process.exitCode = 1 }
