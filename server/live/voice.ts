// Legacy voice storage adapter; standalone core supplies its own scoped vault.
import { readJson, writeJson } from '../store.ts'
import { startVoice as start, type VoiceTools } from '../voice.ts'
export type { VoiceTools } from '../voice.ts'
export function voiceKey(): string | null { return process.env.ELEVENLABS_API_KEY ?? readJson<{ elevenlabs?: string }>('secrets.json', {}).elevenlabs ?? null }
export function startVoice(tools: VoiceTools, out: { send(d: ArrayBuffer | string): void; close(): void }) {
  return start(tools, out, { key: async () => voiceKey(), agent: () => readJson<{ agent?: string }>('voice.json', {}).agent, saveAgent: (_key, agent) => writeJson('voice.json', { agent }) })
}
