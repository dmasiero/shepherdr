import { ClaudeReader } from '../live/readers/claude.ts'
import { CodexReader } from '../live/readers/codex.ts'
import type { LogEvent, Reader } from '../live/readers/types.ts'
import type { Message } from '../../shared/types.ts'
import type { CoreAgents } from './agents.ts'
import type { CoreStore } from './store.ts'
import type { CoreFiles } from './files.ts'
import type { AgentHook, CoreAgent } from './model.ts'
import { CoreNativeFile } from './native-file.ts'
import { CoreReviewReader } from './review-reader.ts'
import { chatMessages } from './chat.ts'

interface Cursor { path: string; file: CoreNativeFile; reader?: Reader }
interface SavedMessage extends Message { source?: string }

/** Native transcripts and explicit hooks only. No terminal reads or screen-status heuristics. */
export class CoreLogs {
  private hooks = new Map<string, Cursor>()
  private logs = new Map<string, Cursor>()
  private busy = new Set<string>()
  private machines = new Map<string, number>()
  private next = 0
  private timer?: ReturnType<typeof setInterval>
  constructor(private readonly agents: CoreAgents, private readonly files: CoreFiles, private readonly store: CoreStore,
    private readonly changed: (chat: string) => void, private readonly error: (chat: string, message: string) => void) {}
  start() { if (!this.timer) this.timer = setInterval(() => void this.poll(), 500); void this.poll() }
  stop() { clearInterval(this.timer); this.timer = undefined }
  async poll() {
    const jobs: Promise<void>[] = []
    const agents = this.agents.all()
    const first = this.next++ % Math.max(1, agents.length)
    for (const agent of [...agents.slice(first), ...agents.slice(0, first)]) {
      if (this.busy.has(agent.chat) || (this.machines.get(agent.machine) ?? 0) >= 4) continue
      this.busy.add(agent.chat); this.machines.set(agent.machine, (this.machines.get(agent.machine) ?? 0) + 1)
      jobs.push((async () => {
        try {
          try { await this.hook(agent) } catch (error) { this.error(agent.chat, (error as Error).message) }
          const current = this.agents.get(agent.chat) ?? agent
          if (current.transcript) await this.transcript(current)
        } catch (error) { this.error(agent.chat, (error as Error).message) }
        finally { this.busy.delete(agent.chat); this.machines.set(agent.machine, (this.machines.get(agent.machine) ?? 1) - 1) }
      })())
    }
    await Promise.all(jobs)
  }

  messages(chat: string): Message[] {
    return chatMessages(this.store.all<SavedMessage>(`message:${chat}`).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).map(({ source, ...message }) => message))
  }
  outgoing(chat: string, message: Message) { this.store.set(`message:${chat}`, message.id, message); this.changed(chat) }

  private async lines(chat: string, machine: string, cursor: Cursor, receive: (lines: { text: string; offset: number }[]) => void) {
    const bun = await this.agents.bun(machine)
    // Bound each poll so a long history does not starve hooks or other chats.
    for (let count = 0; count < 4; count++) {
      const batch = await cursor.file.read(this.files, machine, bun, () => cursor.reader?.reset?.(cursor.path))
      if (batch.oversized) {
        const text = 'A native log record exceeds the 64 MiB display limit and was skipped. Later records will still load.'
        this.error(chat, text)
        this.outgoing(chat, { id: 'native-log-record-limit', who: 'agent', text, at: Date.now() })
      }
      if (batch.lines.length) receive(batch.lines)
      if (!batch.more) break
    }
  }

  private async hook(agent: CoreAgent) {
    let cursor = this.hooks.get(agent.chat)
    if (!cursor || cursor.path !== agent.hook) { cursor = { path: agent.hook, file: new CoreNativeFile(agent.hook) }; this.hooks.set(agent.chat, cursor) }
    await this.lines(agent.chat, agent.machine, cursor, lines => {
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
      cursor = { path: agent.transcript!, file: new CoreNativeFile(agent.transcript!), reader: agent.transcriptFormat === 'codex-exec' ? new CoreReviewReader() : agent.kind === 'claude' ? new ClaudeReader() : new CodexReader() }
      this.logs.set(agent.chat, cursor)
    }
    await this.lines(agent.chat, agent.machine, cursor, lines => {
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
    if (event.kind === 'session') { agent.session = event.sessionId; this.store.set('agent', agent.chat, agent) }
    if (event.kind === 'turn-start' || event.kind === 'turn-end') {
      if (!agent.permission) { agent.state = event.kind === 'turn-start' ? 'working' : 'idle'; this.store.set('agent', agent.chat, agent) }
    }
    if (event.kind !== 'user' && event.kind !== 'agent') return
    if (event.kind === 'user' && /^\s*<restart>/.test(event.text)) return
    if (event.kind === 'agent' && /^\s*<no-reply>[\s\S]*<\/no-reply>\s*$/.test(event.text)) return
    const kind = `message:${agent.chat}`
    if (event.kind === 'user') {
      const delivery = this.store.all<{ id: string; chat: string; launch?: string; text: string; state: string }>('pending-send').find(item => item.chat === agent.chat && (!item.launch || item.launch === agent.launch) && item.state === 'sending' && item.text === event.text)
      if (delivery) {
        this.store.delete('pending-send', delivery.id); this.store.delete(kind, `delivery-${delivery.id}`)
        const optimistic = this.store.get<SavedMessage>(kind, delivery.id)
        if (optimistic) { this.store.set(kind, delivery.id, { ...optimistic, source: event.id, waiting: false, waitsFor: undefined }); return }
      }
      const previous = this.store.all<SavedMessage>(kind).filter(message => message.who === 'you')
      if (previous.some(message => message.source === event.id)) return
      const optimistic = previous.find(message => !message.source && message.text === event.text && Math.abs((message.at ?? 0) - event.at) < 120_000)
      if (optimistic) {
        this.store.set(kind, optimistic.id, { ...optimistic, source: event.id, waiting: false, waitsFor: undefined })
        this.store.delete('pending-send', optimistic.id)
        return
      }
      if (/^\s*<(?:answer|review|review-failed|go|restart|shepherdr|artifact-sent|artifact-note|artifact-comment|browser-notes)\b/.test(event.text)) return
    }
    this.store.set(kind, event.id, { id: event.id, who: event.kind === 'user' ? 'you' : 'agent', text: event.text, at: event.at, source: event.id } satisfies SavedMessage)
  }
}
