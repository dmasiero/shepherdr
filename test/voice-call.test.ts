// fork: what a voice call sends ElevenLabs, with its API and socket faked. ElevenLabs closes a call whose start
// overrides first_message (1008, "Override for field 'first_message' is not allowed by config."), so the first line
// comes from the agent itself, through the agent dynamic variable.
import { afterAll, expect, test } from 'bun:test'
import { startVoice } from '../server/live/voice.ts'

const realFetch = globalThis.fetch
const RealSocket = globalThis.WebSocket
afterAll(() => {
  globalThis.fetch = realFetch
  globalThis.WebSocket = RealSocket
  delete process.env.ELEVENLABS_API_KEY
})

test('a call makes the agent once and starts without a first_message override', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-key'
  const created: Record<string, any>[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/convai/agents/create')) {
      created.push(JSON.parse(String(init?.body)))
      return Response.json({ agent_id: 'agent-1' })
    }
    return Response.json({ signed_url: 'wss://example.test/call' })
  }) as typeof fetch
  const sent: Record<string, any>[] = []
  let opened!: () => void
  const open = new Promise<void>((r) => (opened = r))
  class Socket {
    static OPEN = 1
    readyState = 1
    onopen: (() => void) | null = null
    onmessage: ((e: { data: unknown }) => void) | null = null
    constructor() {
      queueMicrotask(() => {
        this.onopen?.()
        opened()
      })
    }
    send(d: string) {
      sent.push(JSON.parse(d))
    }
    close() {}
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  const tools = { name: 'Nova', send: async () => '', read: async () => '', overview: async () => '', onReply: () => () => {} }
  startVoice(tools, { send() {}, close() {} })
  await open

  expect(created).toHaveLength(1)
  const agent = created[0].conversation_config.agent
  expect(agent.first_message).toBe("You're through to {{agent}}. Go ahead.")
  expect(agent.dynamic_variables).toEqual({ dynamic_variable_placeholders: { agent: 'your agent' } })
  expect(created[0].platform_settings.overrides).toEqual({ conversation_config_override: { agent: { prompt: { prompt: true } } } })

  const start = sent.find((m) => m.type === 'conversation_initiation_client_data')!
  expect(start.dynamic_variables).toEqual({ agent: 'Nova' })
  expect(start.conversation_config_override.agent.first_message).toBeUndefined()
  expect(start.conversation_config_override.agent.prompt.prompt).toContain('the agent they called (Nova)')
})
