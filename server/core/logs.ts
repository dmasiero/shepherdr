import { ClaudeReader } from '../live/readers/claude.ts'
import { CodexReader } from '../live/readers/codex.ts'
import type { LogEvent, Reader } from '../live/readers/types.ts'
import type { Message } from '../../shared/types.ts'
import type { CoreAgents } from './agents.ts'
import type { CoreStore } from './store.ts'
import type { CoreFiles } from './files.ts'
import type { AgentHook, CoreAgent } from './model.ts'

interface Cursor { path: string; line: number; byte: number; reader?: Reader }
interface SavedMessage extends Message { source?: string }

/** Native transcripts and explicit hooks only. No terminal reads or screen-status heuristics. */
export class CoreLogs {
  private hooks = new Map<string, Cursor>()
  private logs = new Map<string, Cursor>()
  private busy = false
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly agents: CoreAgents, private readonly files: CoreFiles, private readonly store: CoreStore,
    private readonly changed: (chat: string) => void, private readonly error: (chat: string, message: string) => void) {}
  start() { if (!this.timer) this.timer = setInterval(() => void this.poll(), 500); void this.poll() }
  stop() { clearInterval(this.timer); this.timer = undefined }
  async poll() {
    if (this.busy) return
    this.busy = true
    try {
      for (const agent of this.agents.all()) {
        try {
          await this.hook(agent)
          const current = this.agents.get(agent.chat) ?? agent
          if (current.transcript) await this.transcript(current)
        } catch (error) { this.error(agent.chat, (error as Error).message) }
      }
    } finally { this.busy = false }
  }
  messages(chat: string): Message[] {
    return this.store.all<SavedMessage>(`message:${chat}`).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(({ source, ...message }) => message)
  }
  outgoing(chat: string, message: Message) { this.store.set(`message:${chat}`, message.id, message); this.changed(chat) }

  private async lines(machine: string, cursor: Cursor, receive: (lines: { text: string; offset: number }[]) => void) {
    let result = await this.files.text(machine, cursor.path, cursor.line, 256)
    if (result.lines < cursor.line - 1) {
      cursor.line = 1; cursor.byte = 0; cursor.reader?.reset?.(cursor.path)
      result = await this.files.text(machine, cursor.path, 1, 256)
    }
    const text = result.text
    const complete = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.slice(0, text.lastIndexOf('\n') + 1).replace(/\n$/, '').split('\n')
    if (!text.includes('\n')) return
    const lines = complete.map(text => {
      const offset = cursor.byte
      cursor.byte += Buffer.byteLength(text) + 1; cursor.line++
      return { text, offset }
    })
    receive(lines)
  }
  private async hook(agent: CoreAgent) {
    let cursor = this.hooks.get(agent.chat)
    if (!cursor || cursor.path !== agent.hook) { cursor = { path: agent.hook, line: 1, byte: 0 }; this.hooks.set(agent.chat, cursor) }
    await this.lines(agent.machine, cursor, lines => {
      for (const line of lines) {
        let event: AgentHook
        try { event = JSON.parse(line.text) } catch { continue }
        if (typeof event.id !== 'string' || typeof event.event !== 'string' || !Number.isFinite(event.at)) continue
        this.agents.hook(agent, event)
      }
    })
  }
  private async transcript(agent: CoreAgent) {
    let cursor = this.logs.get(agent.chat)
    if (!cursor || cursor.path !== agent.transcript) {
      cursor = { path: agent.transcript!, line: 1, byte: 0, reader: agent.kind === 'claude' ? new ClaudeReader() : new CodexReader() }
      this.logs.set(agent.chat, cursor)
    }
    await this.lines(agent.machine, cursor, lines => {
      const events = cursor!.reader!.parse(lines, cursor!.path)
      this.store.db.transaction(() => { for (const event of events) this.apply(agent, event) })()
      if (events.length) this.changed(agent.chat)
    })
  }
  private apply(agent: CoreAgent, event: LogEvent) {
    const current = this.agents.get(agent.chat)
    if (!current || current.launch !== agent.launch || current.grant !== agent.grant) return
    agent = current
    this.store.set(`event:${agent.chat}`, event.id + ':' + event.kind, event)
    if (event.kind === 'turn-start' || event.kind === 'turn-end') {
      if (!agent.permission) { agent.state = event.kind === 'turn-start' ? 'working' : 'idle'; this.store.set('agent', agent.chat, agent) }
    }
    if (event.kind !== 'user' && event.kind !== 'agent') return
    if (event.kind === 'user' && /^\s*<restart>/.test(event.text)) return
    if (event.kind === 'agent' && /^\s*<no-reply>[\s\S]*<\/no-reply>\s*$/.test(event.text)) return
    const kind = `message:${agent.chat}`
    if (event.kind === 'user') {
      const previous = this.store.all<SavedMessage>(kind).filter(message => message.who === 'you')
      if (previous.some(message => message.source === event.id)) return
      const optimistic = previous.find(message => !message.source && message.text === event.text && Math.abs((message.at ?? 0) - event.at) < 120_000)
      if (optimistic) {
        this.store.set(kind, optimistic.id, { ...optimistic, source: event.id, waiting: false, waitsFor: undefined })
        this.store.delete('pending-send', optimistic.id)
        return
      }
      if (/^\s*<(?:answer|go|restart|shepherdr|reaction|reaction-removed|artifact-sent|artifact-note|artifact-comment|browser-notes)\b/.test(event.text)) return
    }
    this.store.set(kind, event.id, { id: event.id, who: event.kind === 'user' ? 'you' : 'agent', text: event.text, at: event.at, source: event.id } satisfies SavedMessage)
  }
}
