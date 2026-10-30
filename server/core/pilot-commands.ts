import { randomUUID } from 'node:crypto'
import { one, parseArgs } from '../live/args.ts'
import type { CoreSource } from './source.ts'
import type { CoreAgent } from './model.ts'
import type { Grant } from './mailbox.ts'
import { Refusal } from './client.ts'

/** Only authenticated contained launches enter here. No caller-supplied actor, run, machine or cwd grants authority. */
export class CorePilotCommands {
  constructor(private source: CoreSource) {}
  private run(agent: CoreAgent) {
    if (!agent.pilot) throw new Refusal('This is not a contained session')
    return this.source.pilots.policy.actor(agent.pilot.run, this.source.pilots.actor(agent))
  }
  secret(agent: CoreAgent, input: unknown) {
    const run = this.run(agent), names = (input as { names?: unknown })?.names
    if (agent.role === 'reviewer' || !Array.isArray(names) || !names.length || names.some(name => typeof name !== 'string' || !run.config.secrets.includes(name))) throw new Refusal('This secret is outside this run’s approved access profile; ask the human')
    return this.source.secrets.use(agent, input)
  }
  async cli(agent: CoreAgent, grant: Grant, args: string[]) {
    if (!Array.isArray(args) || args.length > 256 || args.some(word => typeof word !== 'string' || word.length > 65536)) throw new Refusal('Invalid contained command')
    const parsed = parseArgs(args), words = parsed.words, [command, op] = words
    const run = this.run(agent)
    this.source.pilots.policy.command(run.id, this.source.pilots.actor(agent), words)
    const text = (value: unknown) => ({ out: (typeof value === 'string' ? value : JSON.stringify(value, null, 2)) + '\n', code: 0 })
    if (command === 'help') return text('Contained Shepherdr: show, models, heartbeat, progress [TEXT], complete EVIDENCE, task add/list/show/chat/tell/queue/close, status, checkpoint MESSAGE, review, ready, pr, checks, merge, ask, plan, alert, secret list/ask/run/env, artifact list/show. Every action stays inside this run’s profile and owned tasks.')
    if (command === 'show') return text(this.source.settings.describe(agent.space))
    if (command === 'models') return text(this.source.settings.clis(agent.space))
    if (command === 'heartbeat') return text(this.source.heartbeats.cli(agent, ['heartbeat']))
    if (command === 'progress') {
      if (words.length > 1) {
        if (agent.role !== 'coordinator') throw new Refusal('Only this run’s coordinator saves shared progress')
        const body = words.slice(1).join(' ')
        if (Buffer.byteLength(body) > 32000) throw new Refusal('Keep saved progress under 32 KiB')
        this.source.store.set('pilot-progress', run.id, { text: body, at: Date.now() })
      }
      return text(this.source.store.get<{ text: string }>('pilot-progress', run.id)?.text || 'No saved progress yet.')
    }
    if (command === 'complete') {
      if (words.length !== 2) throw new Refusal('Use shepherdr complete "goal evidence"')
      return text(this.source.pilots.completion.request(agent, words[1]))
    }
    if (command === 'secret') {
      if (agent.role === 'reviewer') throw new Refusal('Reviewers cannot use secrets')
      if (op === 'list') return text(this.source.secrets.vault.visible([agent.space, `m:${agent.machine}`, 'all']).filter(item => run.config.secrets.includes(item.name)).map(item => item.name).join('\n') || 'No approved secrets here yet.')
      if (!run.config.secrets.includes(words[2])) throw new Refusal('That secret is outside this run’s approved access profile; ask the human')
      return text(await this.source.secrets.cli(agent, args))
    }
    if (command === 'ask' || command === 'plan') return text(`Asked: ${this.source.questions.create(grant, args)}`)
    if (command === 'alert') {
      this.source.requirePlugin('alerts')
      const id = randomUUID(), title = words.slice(1).join(' ')
      if (!title || title.length > 240 || (one(parsed, 'body')?.length ?? 0) > 4000) throw new Refusal('Give a short alert title and body')
      this.source.emit('alert', { id, from: this.source.space(agent.space)?.name || 'Shepherdr', title, body: one(parsed, 'body') || '', go: { place: agent.space, task: this.source.tasks.forChat(agent.chat)?.id }, ...(agent.role === 'task' ? { task: true } : {}) })
      return text('Alert sent')
    }
    if (command === 'artifact') {
      this.source.requirePlugin('artifacts')
      if (op === 'list') return text(this.source.artifacts.list().filter(item => item.place === agent.space).map(item => `${item.id} v${item.v} ${item.title}`))
      throw new Refusal('Contained artifact file export is not connected yet; ask the human to open it in the app')
    }
    if (command === 'task' && op === 'add') return this.source.tasks.cli(grant, args)
    if (command === 'task' && op === 'list') return text(this.source.tasks.all().filter(task => task.pilot === run.id && run.tasks.includes(task.id)).map(task => this.source.tasks.view(task)))
    const target = command === 'checkpoint' ? this.source.tasks.forChat(agent.chat) : this.source.tasks.resolve(grant, command === 'task' ? words[2] : op)
    if (!target || target.pilot !== run.id || !run.tasks.includes(target.id) || target.place !== run.place || target.machine !== run.machine) throw new Refusal('This run does not own that task')
    if (command === 'task' && op === 'show') return text(this.source.tasks.view(target))
    if (command === 'task' && op === 'chat') {
      const limit = Number(one(parsed, 'limit') || 20)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Refusal('Choose 1 to 100 chat lines')
      return text(this.source.logs.messages(target.chat).slice(-limit).map(message => ({ who: message.who, text: message.text?.slice(0, 2000), at: message.at })))
    }
    if (agent.role === 'task' && target.chat !== agent.chat) throw new Refusal('A worker may change only its own task')
    if (command === 'checkpoint') {
      const message = words.slice(1).join(' ')
      if (agent.role !== 'task' || !message.trim() || Buffer.byteLength(message) > 16000) throw new Refusal('Give a checkpoint message for your own task')
      return this.source.tasks.change(target.id, async () => {
        if (this.source.tasks.get(target.id)?.workflow !== 'working') throw new Refusal('This task is not currently working')
        const repo = { machine: target.machine, folder: target.folder }
        await this.source.tasks.git.run(repo, ['add', '--all'])
        if (await this.source.tasks.git.clean(repo)) return text('No changes to checkpoint')
        await this.source.tasks.git.run(repo, ['commit', '-F', '-'], 30, message)
        return text(`Checkpoint: ${await this.source.tasks.git.head(repo)}`)
      })
    }
    if ((command === 'merge' || command === 'task' && op === 'merge') && run.config.approvals.includes('merge') && target.mergePolicy !== 'ask') throw new Refusal('This run requires the human’s exact-head merge approval')
    return this.source.tasks.cli(grant, args)
  }
}
