import { hostname, homedir } from 'node:os'
import { basename, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Emitter, type Source, type SourceEvents } from '../source.ts'
import { nameProblem, slugify, type Action, type AddSpace, type Artifact, type Chat, type Folders, type Message, type Question, type Snapshot, type Status, type Task } from '../../shared/types.ts'
import { CoreSession } from './session.ts'
import { CoreStore } from './store.ts'
import { CoreFiles } from './files.ts'
import { CoreAgents } from './agents.ts'
import { CoreLogs } from './logs.ts'
import { Mailbox, type Grant, type MailRequest } from './mailbox.ts'
import { prepareHome } from './home.ts'
import type { CoreConfig } from './config.ts'
import { coreEnvironment } from './config.ts'
import type { AgentKind, CoreAgent, CoreSpace } from './model.ts'
import { CoreTasks } from './tasks.ts'
import { CoreQuestions } from './questions.ts'
import { terminalBridge } from './terminal.ts'
import { CoreError } from './client.ts'
import { CoreSettings } from './settings.ts'
import { CoreSecrets } from './secrets.ts'
import { CoreArtifacts } from './artifacts.ts'
import { CoreChat } from './chat.ts'
import { CoreActivity } from './activity.ts'
import type { ActivityAsk } from '../../shared/types.ts'

interface Machine { id: string; name: string; state: string; host?: string; version?: string; session?: string | null }
interface Permission { id: string; chat: string; grant: string; question: Question; expires: number; settled?: boolean; allow?: boolean }
interface PendingSend { id: string; chat: string; text: string; launch?: string; state: 'queued' | 'sending' | 'uncertain' }

/** Product state is Shepherdr's; terminals, machine commands, files and agent children are core's. */
export class CoreSource extends Emitter<SourceEvents> implements Source {
  readonly kind = 'live' as const
  quiescing = false
  readonly core: CoreSession
  readonly store: CoreStore
  readonly files: CoreFiles
  readonly mailbox: Mailbox
  readonly agents: CoreAgents
  readonly logs: CoreLogs
  readonly tasks: CoreTasks
  readonly questions: CoreQuestions
  readonly settings: CoreSettings
  readonly secrets: CoreSecrets
  readonly artifacts: CoreArtifacts
  readonly chats: CoreChat
  readonly activities: CoreActivity
  private local: { id: string; name: string }
  private machines: Machine[] = []
  private permissions = new Map<string, (answer: { allow: boolean }) => void>()
  private faults = new Map<string, string>()
  private hooks = new Map<Action['type'], (action: Action) => Promise<unknown>>()
  private recovery?: ReturnType<typeof setInterval>
  private recovering = false
  private sending = new Set<string>()
  private refreshing?: Promise<void>
  private discoveringHomes = new Set<string>()

  constructor(readonly config: CoreConfig) {
    super()
    const installation = prepareHome(config.home)
    this.store = new CoreStore(config.home)
    this.local = this.store.get('meta', 'local') ?? { id: installation.id, name: hostname().split('.')[0] }
    this.core = new CoreSession(config.socket)
    this.files = new CoreFiles(this.core, machine => this.route(machine))
    this.mailbox = new Mailbox(config.home, this.core, machine => this.route(machine), (grant, request, id) => this.mail(grant, request, id))
    const changed = (chat: string) => { this.questions?.reconcile(chat); this.secrets?.reconcile(chat); this.emit('chat', chat); this.emit('snapshot'); void this.flush(chat); void this.tasks?.tick().catch(error => this.faults.set('queue', error.message)) }
    this.agents = new CoreAgents(config, installation, this.core, this.store, this.mailbox, machine => this.route(machine), changed, machine => this.machines.find(item => item.id === machine) ?? {})
    this.logs = new CoreLogs(this.agents, this.files, this.store, changed, (chat, message) => { this.faults.set(chat, message) })
    this.settings = new CoreSettings(this.store, this.files, () => this.spaces(), id => id === this.local.id ? this.local.name : this.machineName(id) || id, () => this.emit('snapshot'))
    this.agents.settings = this.settings
    this.tasks = new CoreTasks(this)
    this.questions = new CoreQuestions(this)
    this.secrets = new CoreSecrets(this)
    this.artifacts = new CoreArtifacts(this, installation.id)
    this.chats = new CoreChat(this, installation.id)
    this.activities = new CoreActivity(this)
    this.core.onChange(() => { this.agents.reconcile(); this.emit('snapshot'); for (const agent of this.agents.all()) void this.flush(agent.chat) })
    this.core.onDocument(event => { void this.mailbox.event(String(event.params.data?.name ?? ''), event.params.machine).catch(error => this.faults.set('mailbox', error.message)) })
    this.core.onResync(() => { void this.refresh().then(() => this.mailbox.resync()).catch(error => this.faults.set('core', error.message)) })
  }
  async start() {
    // A previous server's in-flight mailbox claim cannot be re-executed. Mark its cards honestly as interrupted.
    for (const permission of this.store.all<Permission>('permission')) {
      if (!permission.settled) {
        permission.settled = true; permission.allow = false; permission.question.sent = -1; permission.question.said = 'Interrupted; ask again after reconnecting'
        this.store.set('permission', permission.id, permission)
        this.store.set(`message:${permission.chat}`, `permission-${permission.id}`, { id: `permission-${permission.id}`, who: 'agent', question: permission.question, at: Date.now() })
        const agent = this.agents.get(permission.chat)
        if (agent?.permission === permission.id) { delete agent.permission; this.store.set('agent', agent.chat, agent) }
      }
    }
    for (const pending of this.store.all<PendingSend>('pending-send')) {
      if (pending.state === 'sending') {
        pending.state = 'uncertain'; this.store.set('pending-send', pending.id, pending)
        if (pending.launch) this.deliveryNotice(pending, true)
        const message = this.store.get<Message>(`message:${pending.chat}`, pending.id)
        if (message) this.store.set(`message:${pending.chat}`, pending.id, { ...message, waiting: false, waitsFor: undefined })
      }
    }
    for (const agent of this.agents.all()) {
      agent.permission = this.openPermissions(agent)[0]?.id
      this.store.set('agent', agent.chat, agent)
    }
    await this.core.start(); await this.refresh(); this.logs.start()
    this.recovery = setInterval(() => {
      if (this.connected()) { void this.refresh().then(() => this.mailbox.resync()).catch(error => this.faults.set('core', error.message)); void this.tasks.tick().catch(error => this.faults.set('queue', error.message)); return }
      if (this.recovering || this.core.current.error?.includes('requires core')) return
      this.recovering = true
      // Restart the configured, isolated core after a crash. This never updates binaries or stops holders.
      try {
        const child = Bun.spawn([this.config.binary, 'server', 'start'], { env: coreEnvironment(this.config), stdout: 'ignore', stderr: 'ignore' })
        const deadline = setTimeout(() => child.kill(), 10_000)
        void child.exited.finally(() => { clearTimeout(deadline); this.recovering = false })
      } catch { this.recovering = false }
    }, 5000)
  }
  connected() { return this.core.current.connected }
  machineConnected(machine: string) { return this.connected() && (machine === this.local.id || this.machines.some(item => item.id === machine && item.state === 'connected')) }
  localMachineId() { return this.local.id }
  machineName(machine: string) { return machine === this.local.id ? undefined : this.machines.find(item => item.id === machine)?.name }
  registerAction(type: Action['type'], handler: (action: Action) => Promise<unknown>) { this.hooks.set(type, handler) }

  async route(machine: string): Promise<string | undefined> {
    if (machine === this.local.id) return undefined
    const remote = this.machines.find(item => item.id === machine)
    if (!remote) throw new Error('This machine is not connected through core')
    if (remote.state !== 'connected') throw new Error(`${remote.name} is reconnecting`)
    return remote.name
  }
  spaces() { return this.store.all<CoreSpace>('space') }
  space(id: string) { return this.store.get<CoreSpace>('space', id) }
  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.refreshNow().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
  private async refreshNow() {
    const status = await this.core.call<{ core: { id: string; name: string } }>('server.status')
    this.local = status.core; this.store.set('meta', 'local', this.local)
    this.machines = (await this.core.call<{ machines: Machine[] }>('machine.list')).machines
    const homeId = `p:${this.local.id}:~`
    if (!this.space(homeId)) {
      const folder = (await this.files.exec(this.local.id, ['sh', '-c', 'printf %s "$HOME"'])).toString('utf8')
      this.store.set('space', homeId, { id: homeId, name: '~', home: true, machine: this.local.id, folder, base: 'main', prefix: 'TASK', mode: 'regular', added: Date.now() } satisfies CoreSpace)
    }
    for (const machine of this.machines.filter(item => item.state === 'connected')) {
      const id = `p:${machine.id}:~`
      if (this.space(id) || this.discoveringHomes.has(machine.id)) continue
      this.discoveringHomes.add(machine.id)
      // A disconnected remote must never delay or fail the local application startup.
      void this.files.exec(machine.id, ['sh', '-c', 'printf %s "$HOME"']).then(bytes => {
        if (!this.machines.some(item => item.id === machine.id)) return
        this.store.set('space', id, { id, name: '~', home: true, machine: machine.id, folder: bytes.toString('utf8'), base: 'main', prefix: 'TASK', mode: 'regular', added: Date.now() } satisfies CoreSpace)
        this.faults.delete(`machine:${machine.id}`); this.emit('snapshot')
      }).catch(error => {
        machine.state = 'unreachable'; this.faults.set(`machine:${machine.id}`, error.message); this.emit('snapshot')
      }).finally(() => this.discoveringHomes.delete(machine.id))
    }
    this.agents.reconcile(); this.emit('snapshot')
    this.settings.probe(this.local.id)
    for (const machine of this.machines.filter(item => item.state === 'connected')) this.settings.probe(machine.id)
  }

  status(agent?: CoreAgent): Status {
    if (!this.connected()) return 'off'
    if (!agent) return 'idle'
    if (!this.machineConnected(agent.machine)) return 'off'
    if (this.secrets.open(agent.chat).length || this.questions.open(agent.chat).length || this.openPermissions(agent).length) return 'need'
    const terminal = this.agents.terminal(agent)
    if (terminal?.state === 'finished') return 'idle'
    if (agent.pid && terminal?.pid !== agent.pid) return 'need'
    const word = terminal?.status?.state ?? agent.state
    return word === 'blocked' || agent.permission ? 'need' : word === 'working' || word === 'starting' ? 'work' : 'idle'
  }
  private openPermissions(agent: CoreAgent) {
    return this.store.all<Permission>('permission').filter(item => item.chat === agent.chat && item.grant === agent.grant && !item.settled && item.expires > Date.now())
  }
  snapshot(): Snapshot {
    const spaces = this.spaces()
    const asks: Record<string, string> = {}
    for (const permission of this.store.all<Permission>('permission')) {
      if (!permission.settled) asks[permission.chat] = permission.id
    }
    for (const row of this.questions.open()) asks[row.chat] = row.id
    for (const row of this.secrets.open()) asks[row.chat] = row.id
    return {
      terminalTransport: 'core', name: 'Shepherdr', host: this.local.name, user: this.store.get<string>('setting', 'user') || 'You',
      places: spaces.map(space => ({ id: space.id, name: this.store.get<string>('name', space.id) || space.name, machine: space.machine, home: space.home,
        level: space.home ? space.machine === this.local.id ? 0 : 1 : 2, status: this.machineConnected(space.machine) ? this.status(this.agents.get(space.id)) : 'off', mode: space.mode, chat: space.id })),
      machines: [{ id: `m:${this.local.id}`, machine: this.local.id, name: this.local.name, status: this.connected() ? 'idle' : 'off' },
        ...this.machines.map(machine => ({ id: `m:${machine.id}`, machine: machine.id, name: machine.name, status: machine.state === 'connected' ? 'idle' as const : 'off' as const }))],
      tasks: this.tasks.all().map(task => this.tasks.view(task)), artifacts: this.artifacts.list(), automations: {}, asks,
      settings: this.secrets.pages(this.settings.sections()),
      last: Object.fromEntries(this.store.all<{ chat: string; at: number }>('last').map(item => [item.chat, item.at])),
      read: this.store.get<Record<string, number>>('meta', 'read') ?? {},
    }
  }
  chatStatus(chat: string) { return this.status(this.agents.get(chat)) }
  chat(key: string): Chat | undefined {
    const agent = this.agents.get(key)
    if (!agent && !this.space(key) && !this.tasks.forChat(key)) return undefined
    const terminal = agent && this.agents.terminal(agent)
    const status = this.status(agent)
    const messages = this.logs.messages(key)
    if (agent?.kind === 'codex' && agent.state === 'starting' && !agent.transcript) messages.push({ id: `setup-${agent.launch}`, who: 'agent', text: 'Codex may ask you to trust its folder or Shepherdr’s hooks. Open Terminal to review its own prompts. Chat connects after those hooks are trusted.', at: agent.started })
    return { key, ...this.activities.chat(key, messages, terminal?.state === 'live' && status === 'work'), cli: agent?.kind ?? this.agentKind(), working: status === 'work',
      failed: this.store.all<PendingSend>('pending-send').filter(item => item.chat === key && item.state === 'uncertain').map(item => ({ cid: item.id, error: 'Delivery was interrupted; check the chat before sending again' })),
      finished: !!agent && terminal?.state === 'finished', agent: { kind: agent?.kind ?? this.agentKind(), model: agent?.model, effort: agent?.effort } }
  }
  private agentKind(): AgentKind { return this.store.get<string>('setting', 'agent') === 'codex' ? 'codex' : 'claude' }
  post(chat: string, message: Message) {
    this.logs.outgoing(chat, message)
    this.store.set('last', chat, { chat, at: message.at ?? Date.now() }); this.emit('snapshot')
  }
  forwardQuestion(chat: string, question: Question, answer?: string, where: 'space' | 'task' = 'task') {
    const task = this.tasks.forChat(chat)
    if (!task) return
    const id = `ask-${question.id}`, previous = this.store.get<Message>(`message:${task.place}`, id)
    this.post(task.place, { id, who: 'agent', at: previous?.at ?? Date.now(), card: { id, task: task.id, status: answer ? this.tasks.view(task).status : 'need', text: answer ? 'Answered' : 'Needs you',
      ask: { chat, questions: [question], open: answer === undefined, answered: answer === undefined ? undefined : { where, text: answer } } } })
  }

  async act(action: Action): Promise<unknown> {
    if (this.quiescing) throw new Error('Shepherdr is stopping; retry after it reconnects')
    const handler = this.hooks.get(action.type)
    if (handler) return handler(action)
    if ('chat' in action && this.tasks.forChat(action.chat) && ['pin', 'archive', 'pause', 'restart-info', 'restart', 'close', 'delete'].includes(action.type)) return this.tasks.act(action)
    switch (action.type) {
      case 'send': {
        if (!action.text.trim() && !action.attachments?.length) return {}
        const run = async () => {
          const task = this.tasks.forChat(action.chat)
          const space = this.space(action.chat) || task && this.space(task.place)
          if (!space) throw new Error('No such coordinator space')
          const text = await this.chats.text(action, space.machine)
          const id = action.cid || randomUUID()
          this.store.db.transaction(() => {
            this.store.set('pending-send', id, { id, chat: action.chat, text, state: 'queued' } satisfies PendingSend)
            this.post(action.chat, { id, cid: action.cid, who: 'you', text, at: Date.now(), waiting: true, waitsFor: 'start' })
          })()
          await this.flush(action.chat)
          return { ok: true, waiting: !!this.store.get('pending-send', id) }
        }
        return action.cid ? this.store.command(action.cid, action, run) : run()
      }
      case 'answer': {
        if (await this.tasks.answer(action.question, action.choice, action.chat)) return { ok: true }
        if (await this.questions.answer(action)) return { ok: true }
        const permission = this.store.get<Permission>('permission', action.question)
        if (!permission || permission.chat !== action.chat || permission.settled) throw new Error('This request is no longer waiting for an answer')
        if (permission.expires <= Date.now() || this.agents.get(action.chat)?.grant !== permission.grant) throw new Error('This permission belongs to an expired or replaced agent session')
        if (action.choice !== 0 && action.choice !== 1) throw new Error('Choose Allow once or Deny')
        const allow = action.choice === 0
        permission.settled = true; permission.allow = allow; permission.question.sent = action.choice
        this.store.set('permission', permission.id, permission)
        const agent = this.agents.get(action.chat)
        if (agent && agent.permission === permission.id) { agent.permission = this.openPermissions(agent)[0]?.id; agent.state = agent.permission ? 'blocked' : 'working'; this.store.set('agent', agent.chat, agent) }
        this.post(action.chat, { id: `permission-${permission.id}`, who: 'agent', question: permission.question, at: Date.now() })
        this.forwardQuestion(action.chat, permission.question, allow ? 'Allow once' : 'Deny', action.space ? 'space' : 'task')
        this.permissions.get(permission.id)?.({ allow }); this.permissions.delete(permission.id)
        return { answered: true }
      }
      case 'artifact-send': case 'artifact-note': case 'artifact-say': case 'artifact-delete': return this.artifacts.act(action)
      case 'secret': case 'secret-saved': return this.secrets.act(action)
      case 'setting':
        this.settings.set(action.key, action.value, action.place || 'all'); return {}
      case 'keys': case 'text': {
        const agent = this.agents.get(action.chat)
        const terminal = agent && this.agents.terminal(agent)
        if (!terminal || terminal.state !== 'live') throw new Error('This terminal is stopped')
        if (action.type === 'keys') return this.core.call('terminal.keys', { terminal: terminal.address, keys: action.keys })
        const stream = await this.core.attach(terminal.address, { data() {}, close() {} }, terminal.cols, terminal.rows)
        stream.input(Buffer.from(action.text)); stream.close(); return {}
      }
      case 'read': this.store.set('meta', 'read', { ...this.store.get<Record<string, number>>('meta', 'read'), ...action.chats }); this.emit('snapshot'); return {}
      case 'rename': this.store.set('name', action.id, action.name); this.emit('snapshot'); return {}
      case 'react': {
        const text = this.chats.reaction(action.chat, action.message, action.emoji), id = randomUUID()
        this.store.db.transaction(() => {
          this.store.set('pending-send', id, { id, chat: action.chat, text, state: 'queued' } satisfies PendingSend)
          this.post(action.chat, { id, who: 'you', text, at: Date.now(), waiting: true })
        })()
        await this.flush(action.chat); return {}
      }
      case 'restart-info': {
        const agent = this.agents.get(action.chat)
        return { ok: true, info: { role: 'coordinator', space: this.space(action.chat)?.name, on: { kind: agent?.kind ?? this.agentKind(), model: agent?.model, effort: agent?.effort }, onKnown: !!agent,
          onWords: agent?.kind ?? this.agentKind(), want: this.settings.agent('coordinator', action.chat), clis: this.settings.clis(action.chat), working: agent?.state === 'working' } }
      }
      case 'restart': {
        const space = this.space(action.chat)
        if (!space) throw new Error('No such coordinator')
        const agent = this.agents.get(action.chat)
        const terminal = agent && this.agents.terminal(agent)
        if (terminal?.state === 'live') await this.core.call('terminal.kill', { terminal: terminal.address })
        const kind = action.kind || agent?.kind || this.agentKind()
        if (kind !== 'claude' && kind !== 'codex') throw new Error('Choose Claude Code or Codex')
        if (action.save) this.settings.saveAgent('coordinator', space.id, { kind, model: action.model, effort: action.effort })
        await this.agents.launch(space, action.chat, kind, '', { model: action.model, effort: action.effort, resume: true })
        return {}
      }
      default: throw new Error(`This rewrite slice has not implemented ${action.type} yet; see the parity checklist`)
    }
  }

  private async flush(chat: string) {
    if (this.sending.has(chat) || !this.connected()) return
    this.sending.add(chat)
    try {
      const pending = this.store.all<PendingSend>('pending-send').filter(item => item.chat === chat && item.state === 'queued')
      for (const item of pending) {
        const task = this.tasks.forChat(chat)
        const space = this.space(chat) || task && this.space(task.place)
        if (!space) return
        const agent = this.agents.get(chat)
        if (item.launch && (agent?.launch !== item.launch || this.agents.terminal(agent)?.state !== 'live')) { item.state = 'uncertain'; this.store.set('pending-send', item.id, item); this.deliveryNotice(item, true); continue }
        if (agent && (agent.state === 'starting' || this.openPermissions(agent).length)) return
        item.state = 'sending'; this.store.set('pending-send', item.id, item)
        try {
          if (agent && this.agents.terminal(agent)?.state === 'live') await this.agents.send(chat, item.text)
          else if (task) await this.tasks.launch(task, item.text)
          else {
            const pick = this.settings.agent('coordinator', space.id)
            await this.agents.launch(space, chat, agent?.kind ?? pick.kind, item.text, agent ? { model: agent.model, effort: agent.effort, resume: true } : { ...pick, resume: true })
          }
          const message = this.store.get<Message>(`message:${chat}`, item.id)
          if (message) this.store.set(`message:${chat}`, item.id, { ...message, waiting: false, waitsFor: undefined })
        } catch (error) {
          if (error instanceof CoreError && ['blocked', 'status_mismatch', 'busy'].includes(error.kind)) {
            item.state = 'queued'; this.store.set('pending-send', item.id, item); return
          }
          item.state = 'uncertain'; this.store.set('pending-send', item.id, item)
          if (item.launch) this.deliveryNotice(item, true)
          const message = this.store.get<Message>(`message:${chat}`, item.id)
          if (message) this.store.set(`message:${chat}`, item.id, { ...message, waiting: false, waitsFor: undefined })
          this.faults.set(chat, (error as Error).message)
          this.emit('chat', chat); return
        }
      }
    } finally { this.sending.delete(chat) }
  }

  private async mail(grant: Grant, request: MailRequest, requestId: string): Promise<unknown> {
    if (this.quiescing) throw new Error('Shepherdr is stopping; retry after it reconnects')
    const agent = this.agents.get(grant.chat)
    const terminal = agent && this.agents.terminal(agent)
    if (!agent || agent.launch !== grant.session || agent.grant !== grant.id || terminal?.state !== 'live' || agent.pid && terminal.pid !== agent.pid) throw new Error('This session is no longer active')
    if (request.action === 'cli') {
      const input = request.args as { args?: unknown }
      if (!Array.isArray(input.args) || !input.args.every(arg => typeof arg === 'string')) throw new Error('Invalid command words')
      const args = input.args as string[]
      if (!args.length || args[0] === 'help' || args.includes('--help')) return { out: `Shepherdr standalone core commands (authenticated agent session):
  show
  space list | space add PATH
  task add TITLE --brief FULL_BRIEF [--agent claude|codex] [--space NAME] [--later] [--after ID,ID]
  task list | task show ID | task tell ID TEXT | task queue ID --after ID,ID|none
  status ID TEXT --done 0..100 --left 5m|1h20m
  ask TITLE --choice LABEL --choice LABEL | plan TITLE --choice LABEL --choice LABEL
  review ID | pr ID | checks ID
  ready ID --summary TEXT [--facts TEXT]
  merge ID (requires the human's exact-commit card approval)
  todo ID | task close ID
  artifact new FILE --title TITLE | update ID [FILE] [--data JSON] | check FILE | show ID | list | remove ID
  secret list | secret ask NAME --why TEXT [--force]
  secret run NAME [NAME …] -- COMMAND | secret env NAME [NAME …] --file .env
Use hc for starting, messaging and waiting on core child agents. Never use a web URL or legacy helper for core commands.
`, code: 0 }
      if (args[0] === 'secret') {
        if (!grant.actions.includes('secret')) throw new Error('This session has no secret permission')
        return { out: await this.secrets.cli(agent, args) + '\n', code: 0 }
      }
      if (args[0] === 'artifact') {
        if (!grant.actions.includes('artifact')) throw new Error('This session has no artifact permission')
        return { out: await this.artifacts.cli(agent, args, typeof (input as { cwd?: unknown }).cwd === 'string' ? (input as { cwd: string }).cwd : this.space(agent.space)!.folder), code: 0 }
      }
      if (args[0] === 'show') return { out: this.settings.describe(agent.space), code: 0 }
      if (args[0] === 'ask' || args[0] === 'plan') return { out: `Asked: ${this.questions.create(grant, args)}\n`, code: 0 }
      if (args[0] === 'space' && args[1] === 'list') return { out: JSON.stringify(this.spaces().filter(space => space.machine === agent.machine), null, 2) + '\n', code: 0 }
      if (args[0] === 'space' && args[1] === 'add') {
        if (agent.role !== 'coordinator') throw new Error('Only a coordinator can add a space')
        const result = await this.addSpace({ machine: agent.machine, path: args[2] || '' })
        return { out: result.place + '\n', code: 0 }
      }
      return this.tasks.cli(grant, args)
    }
    if (request.action === 'secret') return this.secrets.use(agent, request.args)
    if (request.action !== 'permission') throw new Error('This command is not connected in this rewrite slice')
    const input = request.args as { id?: string; tool?: string; input?: unknown }
    if (typeof input.id !== 'string' || !/^[a-f0-9-]{36}$/.test(input.id) || input.id !== requestId) throw new Error('Invalid permission request identity')
    const previous = this.store.get<Permission>('permission', input.id)
    if (previous && (previous.grant !== grant.id || previous.chat !== grant.chat)) throw new Error('Permission id belongs to another session')
    if (previous?.settled) return { allow: previous.allow === true }
    const question: Question = { id: input.id, title: `${agent.kind === 'claude' ? 'Claude Code' : 'Codex'} asks to use ${String(input.tool || 'a tool').slice(0, 100)}`,
      kind: 'Question', choices: [{ label: 'Allow once' }, { label: 'Deny' }], to: grant.chat, noNote: true,
      screen: JSON.stringify(input.input, null, 2)?.slice(0, 16_000) }
    const permission: Permission = { id: input.id, chat: grant.chat, grant: grant.id, question, expires: request.expires }
    this.store.set('permission', input.id, permission)
    agent.state = 'blocked'; agent.permission = input.id; this.store.set('agent', agent.chat, agent)
    this.post(grant.chat, { id: `permission-${input.id}`, who: 'agent', question, at: Date.now() })
    this.forwardQuestion(grant.chat, question)
    this.emit('alert', { id: input.id, from: 'Shepherdr', title: question.title, body: 'Waiting for your permission', go: { place: agent.space, focus: input.id }, tag: grant.chat,
      card: { chat: grant.chat, question: input.id, choices: question.choices.map((choice, index) => ({ label: choice.label, choice: index })) } })
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.permissions.delete(input.id!)
        permission.settled = true; permission.allow = false; permission.question.sent = -1; permission.question.said = 'Permission request expired'
        this.store.set('permission', permission.id, permission)
        this.post(grant.chat, { id: `permission-${input.id}`, who: 'agent', question: permission.question, at: Date.now() })
        const current = this.agents.get(grant.chat)
        if (current?.grant === grant.id && current.permission === permission.id) { current.permission = this.openPermissions(current)[0]?.id; this.store.set('agent', current.chat, current) }
        resolve({ allow: false })
      }, Math.max(1, request.expires - Date.now() - 1000))
      this.permissions.set(input.id!, answer => { clearTimeout(timer); resolve(answer) })
    })
  }

  async folders(machine: string, path: string): Promise<Folders> {
    const script = `const f=require('node:fs'),p=require('node:path'),o=require('node:os'),c=require('node:child_process');const raw=process.argv.at(-1),home=o.homedir(),target=p.resolve(raw==='~'?home:raw.startsWith('~/')?p.join(home,raw.slice(2)):raw);let x={path:target,exists:f.existsSync(target),dir:false,repo:null,entries:[]};if(x.exists){const real=f.realpathSync(target);if(real!==home&&!real.startsWith(home+p.sep))throw Error('Choose a folder in your home');x.dir=f.statSync(real).isDirectory();if(x.dir){let g=c.spawnSync('git',['-C',real,'rev-parse','--show-toplevel'],{encoding:'utf8'});x.repo=g.status===0?g.stdout.trim():null;x.entries=f.readdirSync(real,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.')).slice(0,200).map(e=>({name:e.name,path:p.join(real,e.name),repo:f.existsSync(p.join(real,e.name,'.git'))}));}}console.log(JSON.stringify(x))`
    const result = JSON.parse((await this.files.exec(machine, [await this.agents.bun(machine), '-e', script, '--', path])).toString('utf8')) as Folders
    for (const entry of result.entries) entry.added = this.spaces().some(space => space.machine === machine && space.folder === entry.path)
    result.added = this.spaces().some(space => space.machine === machine && space.folder === result.repo)
    return result
  }
  async addSpace(request: AddSpace) {
    const folder = await this.folders(request.machine, request.path)
    if (request.create && !folder.exists) {
      // The parent must already resolve inside the user's home; the new leaf is a plain folder name.
      const parent = await this.folders(request.machine, join(folder.path, '..'))
      if (!parent.dir) throw new Error('Choose an existing parent folder')
      await this.files.exec(request.machine, ['mkdir', '-p', folder.path])
      await this.files.exec(request.machine, ['git', 'init', '--initial-branch=main', folder.path])
    }
    const repo = await this.folders(request.machine, folder.path)
    if (!repo.repo) throw new Error('Choose a git repository')
    const existing = this.spaces().find(space => space.machine === request.machine && space.folder === repo.repo)
    if (existing) return { place: existing.id }
    const name = request.name || slugify(basename(repo.repo))
    const problem = nameProblem(name, this.spaces().filter(space => space.machine === request.machine).map(space => space.name))
    if (problem) throw new Error(problem)
    const id = `p:${request.machine}:${name}`
    const base = (await this.files.exec(request.machine, ['git', 'symbolic-ref', '--short', 'HEAD'], repo.repo)).toString().trim()
    this.store.set('space', id, { id, machine: request.machine, name, folder: repo.repo, base, prefix: name.replace(/[^a-z]/gi, '').slice(0, 4).toUpperCase() || 'TASK', mode: 'regular', added: Date.now() } satisfies CoreSpace)
    this.emit('snapshot'); return { place: id }
  }
  watch(_chats: string[], _terms: string[]) {}
  private deliveryNotice(item: PendingSend, uncertain = false) {
    this.post(item.chat, { id: `delivery-${item.id}`, who: 'agent', text: uncertain
      ? 'Shepherdr could not confirm delivery of your saved answer. Check with the agent before answering again; it will not be sent to a replacement session.'
      : 'Shepherdr saved your answer and is waiting for the agent to receive it.', at: Date.now() })
  }
  /** The card's change and its delivery queue entry commit together before any transport effect. */
  saveAndDeliver(chat: string, id: string, text: string, save: () => void) {
    const agent = this.agents.get(chat)
    if (!agent) throw new Error('The card’s agent session is missing')
    this.store.db.transaction(() => {
      save()
      this.store.set('pending-send', id, { id, chat, text, launch: agent.launch, state: 'queued' } satisfies PendingSend)
      this.deliveryNotice({ id, chat, text, launch: agent.launch, state: 'queued' })
    })()
    queueMicrotask(() => { void this.flush(chat) })
  }
  terminal(chat: string, ws: Parameters<typeof terminalBridge>[2]) { return terminalBridge(this, chat, ws) }
  async activity(ask: ActivityAsk) { return this.activities.ask(ask) }
  async artifact(id: string, version?: number) { try { return this.artifacts.page(id, version) } catch { return undefined } }
  async artifactThumb(id: string, dark: boolean) { try { return this.artifacts.thumb(id, dark) } catch { return null } }
  async upload(chat: string, name: string, data: Uint8Array) { return this.chats.upload(chat, name, data) }
  async attachment(chat: string, path: string) { return this.chats.attachment(chat, path) }
  async drain() { this.quiescing = true; return this.tasks.drain() }
  stop() { clearInterval(this.recovery); this.logs.stop(); this.core.stop() }
}
