import type { CoreSource } from './source.ts'

/** Browser socket owns exactly one attach. Disconnect loses unacknowledged input; it is never replayed. */
export function terminalBridge(source: CoreSource, chat: string, ws: { send(data: Uint8Array | string): void; close(): void; buffered(): number }) {
  let ended = false, attached = false, pending = 0, last = 0
  let stream: Awaited<ReturnType<typeof source.core.attach>> | undefined
  let chain = Promise.resolve()
  const agent = source.agents.get(chat), terminal = agent && source.agents.terminal(agent)
  const fail = () => { if (!ended) { ended = true; stream?.close(); ws.close() } }
  const valid = () => !ended && source.plugins?.has('terminal') !== false && agent && source.agents.get(chat)?.launch === agent.launch && source.agents.terminal(agent)?.pid === terminal?.pid
  return {
    message(raw: string) {
      if (ended) return
      if (raw.length > 32_768 || pending >= 64) return fail()
      pending++
      chain = chain.then(async () => {
        if (!valid() || !terminal || terminal.state !== 'live') return fail()
        const message = JSON.parse(raw)
        if (!Number.isSafeInteger(message.id) || message.id <= last) return fail()
        last = message.id
        if (message.type === 'open' && !attached) {
          if (![message.cols, message.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) return fail()
          attached = true
          stream = await source.core.attach(terminal.address, {
            data(bytes) { if (!valid() || ws.buffered() > 1024 * 1024) return fail(); ws.send(bytes) },
            close() { fail() },
          }, message.cols, message.rows)
          if (ended) { stream.close(); return }
        } else if (!stream) return fail()
        else if (message.type === 'text' && typeof message.text === 'string') stream.input(Buffer.from(message.text))
        else if (message.type === 'keys' && Array.isArray(message.keys) && message.keys.length <= 32 && message.keys.every((key: unknown) => typeof key === 'string' && key.length <= 40)) {
          await source.core.call('terminal.keys', { terminal: terminal.address, keys: message.keys })
        } else if (message.type === 'resize' && [message.cols, message.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) stream.resize(message.cols, message.rows)
        else return fail()
        if (!ended) ws.send(JSON.stringify({ type: 'ack', id: message.id }))
      }).catch(fail).finally(() => { pending-- })
    },
    end() { ended = true; stream?.close() },
  }
}
