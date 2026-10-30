// OUTSIDE containment. This closure owns the credential and cwd; neither comes from gateway input.
import { randomUUID } from 'node:crypto'
import { coreRequest } from '../server/core/request.ts'
import type { CoreEndpoint } from '../server/core/client.ts'
import type { MailCredential } from '../server/core/envelope.ts'
import type { PilotProxyBackend } from './core-pilot-proxy.ts'

type Request = typeof coreRequest
export function pilotCoreBackend(endpoint: CoreEndpoint, credential: MailCredential, cwd: string, request: Request = coreRequest): PilotProxyBackend {
  const call = (action: string, args: unknown, id: string, signal: AbortSignal, timeout = 110_000) => request(endpoint, credential, action, args, { id, signal, timeout })
  return {
    cli: (args, stdin, id, signal) => call('cli', { args, cwd, ...(stdin === undefined ? {} : { stdin }) }, id, signal),
    secret: (names, id, signal) => call('secret', { names }, id, signal, 60_000),
    hook: (input, id, signal) => call('pilot', { op: 'hook', input }, id, signal, 3_500_000),
    lease: async signal => { await call('pilot', { op: 'lease' }, randomUUID(), signal, 15_000) },
    reserve: async (bytes, signal) => { await call('pilot', { op: 'traffic', bytes }, randomUUID(), signal, 15_000) },
  }
}
