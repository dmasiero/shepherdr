// fork: what a voice call sends ElevenLabs, with its API and socket faked. ElevenLabs closes a call whose start
// overrides first_message (1008, "Override for field 'first_message' is not allowed by config."), so the first line
// comes from the agent itself, through the agent dynamic variable.
import { expect, test } from 'bun:test'
import { startVoice, type VoiceTools } from '../server/voice.ts'

const tools: VoiceTools = { name: 'nextgate:REN-11', send: async () => 'Sent', read: async () => '', overview: async () => '', onReply: () => () => {} }

test('a call makes the agent with its own first message and starts without a first_message override', async () => {
  const created: Record<string, any>[] = [], upstream: Record<string, any>[] = []
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw: string) => upstream.push(JSON.parse(raw)), close() {} } as unknown as WebSocket
  const bridge = startVoice(tools, { send() {}, close() {} }, {
    key: async () => 'test-voice-key-1234', agent: () => undefined, saveAgent() {}, socket: () => socket,
    fetch: async (url, init) => {
      if (url.endsWith('/convai/agents/create')) { created.push(JSON.parse(init!.body as string)); return Response.json({ agent_id: 'agent_test' }) }
      return Response.json({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=test' })
    },
  })
  try {
    for (let turn = 0; !socket.onopen && turn < 20; turn++) await Bun.sleep(0)
    socket.onopen!(new Event('open'))

    expect(created).toHaveLength(1)
    const agent = created[0].conversation_config.agent
    expect(agent.first_message).toBe("You're through to {{agent}}. Go ahead.")
    expect(agent.dynamic_variables).toEqual({ dynamic_variable_placeholders: { agent: 'your agent' } })
    expect(created[0].platform_settings.overrides).toEqual({ conversation_config_override: { agent: { prompt: { prompt: true } } } })

    const start = upstream.find(message => message.type === 'conversation_initiation_client_data')!
    expect(start.dynamic_variables).toEqual({ agent: 'nextgate:REN-11' })
    expect(start.conversation_config_override.agent).not.toHaveProperty('first_message')
    expect(start.conversation_config_override.agent.prompt.prompt).toContain('the agent they called (nextgate:REN-11)')
  } finally { bridge.end() }
})
