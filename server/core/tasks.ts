import { CoreError, Refusal } from './client.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SUMMARY_MAX, TITLE_MAX, STATUS_MAX, slugify, type Action, type Question, type Task } from '../../shared/types.ts'
import { CorePilotRepositories } from './pilot-repositories.ts'
import { CoreGit } from './git.ts'
import type { CoreSource } from './source.ts'
import type { AgentKind, CoreSpace } from './model.ts'
import type { Grant } from './mailbox.ts'
import { one, parseArgs, summaryOpts } from '../live/args.ts'
import type { LogEvent } from '../live/readers/types.ts'
import { reserveTaskId } from './ids.ts'
import { taskDependencies } from './dependencies.ts'
import { archiveAfterMs } from '../../shared/archive.ts'

export interface CoreTask extends Task {
  branch: string
  base: string
  machine: string
  folder: string
  repo: string
  chat: string
  kind: AgentKind
  workflow: 'todo' | 'queued' | 'working' | 'ready' | 'merging' | 'merged' | 'closed'
  mergePolicy: 'ask' | 'checks' | 'auto'
  readyHead?: string
  approvedHead?: string
  review: { on: boolean; kind: AgentKind; rounds: number; mustFix: string }
  reviewTerminal?: string
  reviewRound?: number
  reviewChat?: string
  reviewHead?: string
  reviewReport?: string
  reviewTurn?: string
  reviewFailure?: string
  mergeQuestion?: string
  startError?: string
  model?: string
  effort?: string
  mergeCommit?: string
  localId?: string
  automation?: string
  capacity?: string
  reservedAt?: number
  reservedChats?: string[]
  unarchived?: number
  reviewerModel?: string
  reviewerEffort?: string
}

/** Workflow is explicit persisted metadata, mirrored to core labels. It is never inferred from process exit. */
export class CoreTasks {
  readonly git: CoreGit
  private ticking = false
  private merging = new Set<string>()
  private changing = new Set<string>()
  private drains = new Set<() => void>()
  constructor(private readonly source: CoreSource) { this.git = new CoreGit(source.files, (repo, additional) => new CorePilotRepositories(source.store).context(repo, additional), machine => source.agents.browserRuntime(machine)) }
  /** Internal product transaction gate; callbacks never come from network input. */
  async change<T>(id: string, perform: () => Promise<T>): Promise<T> {
    if (this.source.quiescing) throw new Refusal('Shepherdr is stopping; retry after it restarts')
    if (this.changing.has(id) || this.merging.has(id)) throw new Refusal('This task is finishing another action; retry after it finishes')
    const chat = this.get(id)?.chat
    this.changing.add(id)
    try { return await perform() } finally { this.changing.delete(id); this.settled(); if (chat) this.source.retry?.(chat) }
  }
  busy(id: string) { return this.changing.has(id) || this.merging.has(id) }
  private settled() {
    if (this.changing.size || this.merging.size) return
    for (const resolve of this.drains) resolve()
    this.drains.clear()
  }
  all() { return this.source.store.all<CoreTask>('task') }
  get(id: string) { return this.source.store.get<CoreTask>('task', id) }
  forChat(chat: string) { return this.all().find(task => task.chat === chat || `${task.id}/Reviewer` === chat || chat.startsWith(`${task.id}/Reviewer-`)) }
  private save(task: CoreTask) { this.source.store.set('task', task.id, task); this.source.emit('snapshot') }
  private assert(grant: Grant, task: CoreTask) {
    const agent = this.source.agents.get(grant.chat)
    if (!agent || agent.launch !== grant.session || agent.grant !== grant.id || agent.machine !== task.machine ||
      !(grant.chat === task.chat || (agent.role === 'coordinator' && agent.space === task.place))) throw new Refusal('This session does not own that task')
  }
  view(task: CoreTask): Task {
    const agent = this.source.agents.get(task.chat)
    const terminal = agent && this.source.agents.terminal(agent)
    const status = task.startError ? 'need' : task.workflow === 'merged' || task.workflow === 'closed' ? 'done' : task.workflow === 'ready' ? 'ready' : task.workflow === 'merging' ? 'merging'
      : task.workflow === 'queued' ? 'queued' : task.workflow === 'todo' || !agent ? 'todo' : this.source.status(agent) === 'need' || terminal?.state === 'finished' ? 'need' : 'work'
    return { ...task, status, sub: task.capacity ? `Waiting: ${task.capacity}` : task.sub, browser: agent?.browser ? { ready: this.source.machineConnected?.(task.machine) ?? true, hint: this.source.machineConnected?.(task.machine) === false ? 'This machine is reconnecting' : undefined } : { ready: false, hint: 'Start or restart the task agent to provision its shared browser' }, agent: agent ? { chat: task.chat, role: 'Agent', cli: agent.kind, status: this.source.status(agent) === 'off' ? 'off' : status, age: task.age, note: task.report?.msg || '' } : undefined,
      state: status === 'done' ? task.workflow === 'closed' ? 'Done' : 'Merged' : status === 'ready' ? 'Ready' : status === 'need' ? 'Needs you' : status === 'queued' ? 'Queued' : status === 'todo' ? 'To do' : status === 'merging' ? 'Merging' : 'Working' }
  }
  async add(grant: Grant, input: { title: string; brief: string; space?: string; base?: string; after?: string[]; later?: boolean; kind?: AgentKind; model?: string; effort?: string }) {
    const caller = this.source.agents.get(grant.chat)
    if (caller?.role !== 'coordinator' || caller.grant !== grant.id || caller.launch !== grant.session) throw new Refusal('Only a coordinator can add a task')
    const space = input.space ? this.source.spaces().find(space => space.id === input.space || space.name === input.space && space.machine === caller.machine) : this.source.space(caller.space)
    if (!space || space.home) throw new Refusal('Choose a repository space for the task')
    if (space.machine !== caller.machine) throw new Refusal('Use the coordinator of the task’s machine')
    return this.addInSpace(space, input)
  }
  /** Trusted product scheduler entry; no caller labels or mailbox data grant this authority. */
  async addInSpace(space: CoreSpace, input: { title: string; brief: string; base?: string; after?: string[]; later?: boolean; kind?: AgentKind; model?: string; effort?: string; automation?: string }) {
    if (!input.title.trim() || input.title.length > TITLE_MAX) throw new Refusal(`Write a title of at most ${TITLE_MAX} characters`)
    if (!input.brief.trim()) throw new Refusal('Give the task its full brief')
    if (!this.source.space(space.id) || space.home) throw new Refusal('Choose a repository space for the task')
    const { id, localId, number } = reserveTaskId(this.source.store, space.machine, space.prefix, this.source.machineName(space.machine))
    const branch = `work/${number}-${slugify(input.title).slice(0, 40)}`
    const folder = join(await this.source.agents.worktreeRoot(space.machine), space.name, branch.replaceAll('/', '-'))
    const after = taskDependencies(this.all(), { id, place: space.id, machine: space.machine }, input.after ?? [], machine => this.source.machineName(machine))
      .filter(id => !['merged', 'closed'].includes(this.get(id)!.workflow))
    const defaults = this.source.settings.launch('task', space.id, input.kind)
    const reviewer = this.source.settings.agent('reviewer', space.id)
    const merge = this.source.settings.get('brief.merge', space.id)
    const task: CoreTask = {
      id, localId, automation: input.automation, name: input.title.trim(), desc: input.brief, place: space.id, machine: space.machine, folder, repo: space.folder, branch, base: input.base || space.base,
      chat: `${id}/Agent`, kind: input.kind || defaults.kind, model: input.model || defaults.model, effort: input.effort || defaults.effort, workflow: after.length ? 'queued' : input.later ? 'todo' : 'working', status: after.length ? 'queued' : input.later ? 'todo' : 'work',
      reviewerModel: reviewer.model, reviewerEffort: reviewer.effort, mergePolicy: merge === 'ask me first' ? 'ask' : merge === 'after GitHub checks' ? 'checks' : 'auto', review: { on: this.source.settings.get('brief.review', space.id) === 'on', kind: reviewer.kind, rounds: parseInt(this.source.settings.get('review.rounds', space.id)), mustFix: this.source.settings.get('review.mustFix', space.id) }, after, age: 'now', created: new Date().toISOString(), on: this.source.snapshot().host, state: 'Working',
    }
    return this.change(task.id, async () => {
      this.save(task) // Number and record survive a failed worktree/agent start; never reuse their branch number.
      try {
        await this.source.files.exec(space.machine, ['mkdir', '-p', join(folder, '..')])
        await this.git.addWorktree({ machine: space.machine, folder: space.folder }, folder, branch, task.base!)
        await this.launchNow(task, undefined, task.model, task.effort)
      } catch (error) { task.startError = (error as Error).message; task.workflow = 'todo'; delete task.reservedAt; this.save(task); throw error }
      this.card(task, task.workflow === 'queued' ? task.capacity ? 'Queued: ' + task.capacity : 'Queued after ' + after.join(', ') : task.workflow === 'todo' ? 'Waiting for your go' : 'Started')
      return task
    })
  }
  async launch(task: CoreTask, message?: string, model = task.model, effort = task.effort) { return this.change(task.id, () => this.launchNow(task, message, model, effort)) }
  async deliver(id: string, chat: string, message: string, internal = false) {
    return this.change(id, async () => {
      const task = this.get(id)
      if (!task) throw new Refusal('This task was removed; nothing was sent')
      const agent = this.source.agents.get(chat)
      if (this.forChat(chat)?.id !== id) throw new Refusal('This chat does not belong to that task')
      if (task.workflow !== 'working') {
        const room = this.source.health?.room(task.machine, task.id)
        if (room) { task.capacity = room; if (['todo', 'queued'].includes(task.workflow)) task.workflow = 'queued'; this.save(task); throw new CoreError('busy', 'This message is saved until its machine has room') }
        task.reservedAt = Date.now(); task.reservedChats = [...new Set([...(task.reservedChats ?? []), chat])]
        if (!internal && chat === task.chat && task.workflow === 'ready') { task.workflow = 'working'; delete task.readyHead; delete task.approvedHead; delete task.mergeQuestion }
        if (task.workflow === 'queued' && task.capacity && !(task.after ?? []).some(id => !['merged', 'closed'].includes(this.get(id)?.workflow || ''))) task.workflow = 'working'
        delete task.capacity; this.save(task)
      }
      if (agent && this.source.agents.terminal(agent)?.state === 'live') await this.source.agents.send(chat, message)
      else if (chat === task.chat) { await this.launchNow(task, message); if (this.get(task.id)?.capacity) throw new CoreError('busy', 'This task is queued until its machine has room') }
      else throw new Refusal('This reviewer has finished; request a fresh review')
    })
  }
  private async launchNow(task: CoreTask, message?: string, model = task.model, effort = task.effort) {
    task = this.get(task.id) || (() => { throw new Refusal('No such task') })()
    const space = this.source.space(task.place)
    if (!space) throw new Refusal('Task space is missing')
    const prior = this.source.agents.get(task.chat)
    if (prior && this.source.agents.terminal(prior)?.state === 'live') throw new Refusal('This task agent is already running')
    const capacity = task.workflow !== 'todo' && this.source.health?.room(task.machine, task.id)
    if (capacity) { task.workflow = 'queued'; task.capacity = capacity; this.save(task); return }
    if (task.capacity) { if (!(task.after ?? []).some(id => !['merged', 'closed'].includes(this.get(id)?.workflow || ''))) task.workflow = 'working'; delete task.capacity }
    if (task.workflow !== 'todo') { task.reservedAt = Date.now(); task.reservedChats = [...new Set([...(task.reservedChats ?? []), task.chat])]; this.save(task) }
    await this.source.browsers?.close(task.id)
    let parent = this.source.agents.get(space.id)
    if (!parent || this.source.agents.terminal(parent)?.state !== 'live') {
      const pick = this.source.settings.agent('coordinator', space.id)
      parent = await this.source.agents.launch(space, space.id, pick.kind, '', pick)
    }
    const wait = task.workflow === 'queued' ? `This task is queued after ${task.after?.join(', ')}. Read the brief, then wait for <go>. Do not start implementation yet.`
      : task.workflow === 'todo' ? 'Read the brief, then wait for the human’s go. Do not start implementation yet.' : ''
    const role = readFileSync(join(import.meta.dir, '../../skill/shepherdr-agent/SKILL.md'), 'utf8')
    const instructions = `${role}\n\nYou are ${task.id} in standalone Shepherdr on core. Use the launch-provisioned authenticated shepherdr command. Use hc for child agents, messages and waits. Do not use legacy helpers, SSH workers, a web URL or screen scraping. Your branch is ${task.branch}; stay in this worktree.\n`
    const prompt = `${task.desc}\n\n${wait}\n\nSettings:\n- Review: ${task.review.on ? 'on' : 'off'}\n- Reviewer: ${task.review.kind}\n- Must fix: ${task.review.mustFix}\n- Review rounds: ${task.review.rounds}\n- Merge: ${task.mergePolicy === 'ask' ? 'ask the human first' : task.mergePolicy === 'checks' ? 'after GitHub checks' : 'on its own'}\n${message ? `\n<go>${message}</go>` : ''}`
    await this.source.agents.launch(space, task.chat, task.kind, prompt, { role: 'task', parent, folder: task.folder, task: task.id, instructions, model, effort, resume: true })
    await this.label(task)
  }
  private async label(task: CoreTask) {
    const agent = this.source.agents.get(task.chat), terminal = agent && this.source.agents.terminal(agent)
    if (terminal) await this.source.core.call('terminal.label', { terminal: terminal.address, labels: { 'shepherdr.state': task.workflow } })
  }
  private card(task: CoreTask, text: string) {
    const id = randomUUID()
    this.source.post(task.place, { id, who: 'agent', card: { id, task: task.id, status: this.view(task).status, text }, at: Date.now() })
  }
  async ready(grant: Grant, id: string, summary: string, facts?: string) { return this.change(id, () => this.readyNow(grant, id, summary, facts)) }
  private async readyNow(grant: Grant, id: string, summary: string, facts?: string) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (!summary.trim() || summary.length > SUMMARY_MAX) throw new Refusal(`Write a summary of at most ${SUMMARY_MAX} characters`)
    if (!await this.git.clean({ machine: task.machine, folder: task.folder })) throw new Refusal('Commit or remove the worktree changes before reporting ready')
    task.readyHead = await this.git.head({ machine: task.machine, folder: task.folder })
    if (task.review.on && (!task.reviewReport || !task.reviewTurn || task.reviewHead !== task.readyHead)) throw new Refusal('Complete a fresh review of this exact commit before reporting ready')
    delete task.approvedHead
    task.said = summary; task.facts = facts; task.workflow = 'ready'; delete task.reservedAt
    this.save(task); await this.label(task); this.card(task, summary)
    if (task.mergePolicy === 'ask') {
      const question: Question = { id: randomUUID(), title: `Merge ${task.id}?`, kind: 'Question', choices: [{ label: 'Merge' }, { label: 'Not yet' }], to: task.chat }
      task.mergeQuestion = question.id; this.save(task)
      this.source.store.set('merge-question', question.id, { task: task.id, head: task.readyHead })
      this.source.post(task.chat, { id: question.id, who: 'agent', question, at: Date.now() })
    }
    return task
  }
  async answer(question: string, choice: number, chat: string): Promise<boolean> {
    const request = this.source.store.get<{ task: string }>('merge-question', question)
    return request ? this.change(request.task, () => this.answerNow(question, choice, chat)) : false
  }
  private async answerNow(question: string, choice: number, chat: string): Promise<boolean> {
    const request = this.source.store.get<{ task: string; head: string }>('merge-question', question)
    if (!request) return false
    const task = this.get(request.task)
    if (!task || task.chat !== chat || task.mergeQuestion !== question || task.workflow !== 'ready') throw new Refusal('This merge request is no longer current')
    if (choice !== 0 && choice !== 1) throw new Refusal('Choose Merge or Not yet')
    if (choice === 0) {
      const head = await this.git.head({ machine: task.machine, folder: task.folder })
      if (head !== request.head) throw new Refusal('The task changed after this request; ask for a fresh ready report')
      task.approvedHead = head
    } else delete task.approvedHead
    this.source.saveAndDeliver(chat, `answer-${question}`, `<answer question="Merge ${task.id}?">${choice === 0 ? 'Merge' : 'Not yet'}</answer>`, () => {
      this.source.store.delete('merge-question', question)
      this.source.store.set('task', task.id, task)
    })
    const message = this.source.store.get<{ question: Question }>(`message:${chat}`, question)
    if (message) this.source.post(chat, { ...message, id: question, who: 'agent', question: { ...message.question, sent: choice }, at: Date.now() })
    this.save(task)
    return true
  }
  async merge(grant: Grant, id: string) {
    if (this.source.quiescing) throw new Refusal('Shepherdr is stopping; retry after it restarts')
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (task.workflow === 'merged') return task
    if (this.changing.has(id) || this.merging.has(id)) throw new Refusal('This task is finishing another action; retry after it finishes')
    if (this.all().some(other => other.id !== id && other.machine === task.machine && other.repo === task.repo && this.merging.has(other.id))) throw new Refusal('Another task is merging into this repository; retry after it finishes')
    this.merging.add(id)
    try {
      const worktree = { machine: task.machine, folder: task.folder }, repo = { machine: task.machine, folder: task.repo }
      const head = await this.git.head(worktree)
      if (!task.readyHead || head !== task.readyHead) throw new Refusal('Report this exact commit ready before merging')
      if (task.mergePolicy === 'ask' && task.approvedHead !== head) throw new Refusal('The human must approve this commit using its merge card first')
      if (!await this.git.clean(worktree)) throw new Refusal('The worktree has uncommitted work')
      const remote = await this.git.remote(repo)
      if (task.mergePolicy === 'checks' && !remote) throw new Refusal('This merge requires verified GitHub checks; the repository has no GitHub remote')
      if (remote) {
        const pr = await this.git.pullRequest(worktree, task.branch!)
        if (pr.headRefOid !== head || pr.baseRefName !== task.base) throw new Refusal('The pull request head or base differs from the approved task')
        if (pr.state !== 'MERGED') {
          if (task.mergePolicy === 'checks' && !pr.statusCheckRollup.length) throw new Refusal('No GitHub checks have reported for this commit')
          if (pr.statusCheckRollup.some(check => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion || check.state || 'PENDING'))) throw new Refusal('GitHub checks are not green')
          task.workflow = 'merging'; this.save(task); await this.label(task)
          await this.git.ghRun({ machine: task.machine, folder: task.folder }, ['pr', 'merge', String(pr.number), '--squash', '--match-head-commit', head, '--repo', remote], 90)
        }
        const done = await this.git.pullRequest(worktree, task.branch!)
        if (done.state !== 'MERGED') throw new Refusal('GitHub has not confirmed the merge')
        const merged = done.mergeCommit?.oid
        if (!merged || !/^[a-f0-9]{40,64}$/.test(merged)) throw new Refusal('GitHub confirmed the merge but has not returned its commit yet; retry to finish recording it')
        task.mergeCommit = merged; this.save(task)
      } else {
        if (!await this.git.clean(repo)) throw new Refusal('The base checkout has uncommitted work')
        if (await this.git.run(repo, ['symbolic-ref', '--short', 'HEAD']) !== task.base) throw new Refusal('The base branch is not checked out')
        if (!task.mergeCommit || !await this.git.contains(repo, task.base!, task.mergeCommit)) {
          const base = await this.git.head(repo, task.base)
          let tree: string
          try { tree = (await this.git.run(repo, ['merge-tree', '--write-tree', base, head])).split('\n')[0] }
          catch { throw new Refusal('Conflict with the base branch; rebase in the task worktree and report ready again') }
          if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Refusal('Git did not return a merge tree')
          const oldTree = await this.git.run(repo, ['rev-parse', `${base}^{tree}`])
          if (tree === oldTree) throw new Refusal('There are no changes to merge; mark the task done without merging')
          const message = `${task.id}: ${task.name}\n\n${task.said || ''}${task.facts ? '\n\nFacts: ' + task.facts : ''}\n`
          task.mergeCommit = await this.git.run({ machine: task.machine, folder: task.repo }, ['commit-tree', tree, '-p', base, '-F', '-'], 30, message)
          this.save(task) // Persist the prepared commit before the only base-ref/worktree change.
          task.workflow = 'merging'; this.save(task); await this.label(task)
          await this.git.run(repo, ['merge', '--ff-only', task.mergeCommit])
        }
      }
      task.workflow = 'merged'; task.status = 'done'; task.doneAt = Date.now(); task.outcome = 'done'
      this.save(task); await this.label(task); this.card(task, task.said || 'Merged')
      await this.source.browsers?.close(task.id, true).catch(() => this.source.post(task.chat, { id: 'browser-cleanup-pending', who: 'agent', text: 'The task merged. Browser cleanup is waiting for its machine to reconnect.', at: Date.now() }))
      return task
    } finally {
      this.merging.delete(id)
      this.settled(); this.source.retry?.(task.chat)
    }
  }
  async drain() {
    const waiting = this.merging.size > 0 || this.changing.size > 0
    if (waiting) await new Promise<void>(resolve => this.drains.add(resolve))
    return waiting
  }
  async pr(grant: Grant, id: string) { return this.change(id, () => this.prNow(grant, id)) }
  private async prNow(grant: Grant, id: string) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    const repo = { machine: task.machine, folder: task.folder }
    const remote = await this.git.remote(repo)
    if (!remote) throw new Refusal('This task has no GitHub origin')
    await this.git.run(repo, ['push', '-u', 'origin', task.branch!], 90)
    let pr
    try { pr = await this.git.pullRequest(repo, task.branch!) }
    catch {
      await this.git.ghRun({ machine: task.machine, folder: task.folder }, ['pr', 'create', '--draft', '--base', task.base!, '--head', task.branch!, '--title', `${task.id}: ${task.name}`, '--body-file', '-'], 60, task.said || task.desc || task.name)
      pr = await this.git.pullRequest(repo, task.branch!)
    }
    task.pr = { number: pr.number, url: pr.url }; this.save(task)
    return task.pr
  }
  async report(grant: Grant, id: string, message: string, progress: number, eta?: number) { return this.change(id, () => this.reportNow(grant, id, message, progress, eta)) }
  private async reportNow(grant: Grant, id: string, message: string, progress: number, eta?: number) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (message.length > STATUS_MAX || !Number.isFinite(progress) || progress < 0 || progress > 100) throw new Refusal('Invalid progress report')
    task.report = { msg: message, progress, eta }; this.save(task)
  }
  async act(action: Action): Promise<unknown> {
    if (!('chat' in action)) throw new Refusal('Task action has no chat')
    const task = this.forChat(action.chat)
    if (!task) throw new Refusal('No such task')
    return action.type === 'restart-info' ? this.actNow(action) : this.change(task.id, () => this.actNow(action))
  }
  private async actNow(action: Action): Promise<unknown> {
    if (!('chat' in action)) throw new Refusal('Task action has no chat')
    const task = this.forChat(action.chat)
    if (!task) throw new Refusal('No such task')
    if (this.merging.has(task.id) && !['pin', 'restart-info'].includes(action.type)) throw new Refusal('The merge must finish before changing this task')
    const agent = this.source.agents.get(task.chat), terminal = agent && this.source.agents.terminal(agent)
    switch (action.type) {
      case 'pin': task.pinned = action.on ? Date.now() : undefined; this.save(task); return { ok: true }
      case 'archive':
        if (action.on) this.source.cancelQueued?.(task.chat)
        if (action.on && terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
        if (action.on) await this.source.browsers?.close(task.id, task.workflow === 'merged' || task.workflow === 'closed')
        task.archived = action.on ? Date.now() : undefined
        if (action.on) delete task.pinned; else task.unarchived = Date.now()
        this.save(task); return { ok: true }
      case 'pause':
        this.source.cancelQueued?.(task.chat)
        if (terminal?.state === 'live') await this.source.core.call('terminal.interrupt', { terminal: terminal.address })
        await this.source.browsers?.close(task.id)
        task.workflow = 'todo'; delete task.reservedAt; this.save(task); await this.label(task); return { ok: true }
      case 'restart-info': return { ok: true, info: { role: 'task', space: this.source.space(task.place)?.name, on: { kind: agent?.kind ?? task.kind, model: agent?.model, effort: agent?.effort }, onKnown: !!agent,
        onWords: agent?.kind ?? task.kind, want: this.source.settings.agent('task', task.place), working: agent?.state === 'working',
        clis: this.source.settings.clis(task.place) } }
      case 'restart':
        if (action.kind && action.kind !== 'claude' && action.kind !== 'codex') throw new Refusal('Choose Claude Code or Codex')
        if (terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
        await this.source.browsers?.close(task.id)
        task.kind = action.kind as AgentKind || task.kind; task.model = action.model || undefined; task.effort = action.effort || undefined
        if (action.save) this.source.settings.saveAgent('task', task.place, { kind: task.kind, model: task.model, effort: task.effort })
        delete task.startError; this.save(task)
        await this.launchNow(task, 'Continue your agreed task. Preserve existing work.', task.model, task.effort)
        return { ok: true }
      case 'close': return this.closeNow(task, !!action.force)
      case 'delete': return this.removeNow(task, !!action.force)
      default: throw new Refusal('Unsupported task action')
    }
  }
  private async held(task: CoreTask) {
    const repo = { machine: task.machine, folder: task.repo }
    const list = await this.git.run(repo, ['worktree', 'list', '--porcelain'])
    const block = list.split('\n\n').find(block => block.split('\n').includes(`worktree ${task.folder}`))
    if (block && !block.split('\n').includes(`branch refs/heads/${task.branch}`)) throw new Refusal('This worktree now belongs to another branch; it was left untouched')
    const held: string[] = []
    if (block && !await this.git.clean({ machine: task.machine, folder: task.folder })) held.push('uncommitted changes')
    let head: string | undefined
    try { head = await this.git.head(repo, task.branch) } catch { /* a failed setup may have made no branch */ }
    if (head && !await this.git.contains(repo, task.base!, head)) {
      const squashed = task.workflow === 'merged' && task.readyHead === head && task.mergeCommit && await this.git.contains(repo, task.base!, task.mergeCommit)
      if (!squashed) held.push('unmerged commits')
    }
    return { held, worktree: !!block, branch: !!head }
  }
  private async stopAgents(task: CoreTask) {
    for (const agent of this.source.agents.all().filter(agent => agent.chat.startsWith(`${task.id}/`))) {
      const terminal = this.source.agents.terminal(agent)
      if (terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
      this.source.mailbox.revoke(agent.chat)
    }
    await this.source.browsers?.close(task.id)
  }
  async close(task: CoreTask, force = false) { return this.change(task.id, () => this.closeNow(task, force)) }
  private async closeNow(task: CoreTask, force = false) {
    task = this.get(task.id) || (() => { throw new Refusal('No such task') })()
    const { held } = await this.held(task)
    if (held.length && !force) return { ok: false, held }
    await this.stopAgents(task)
    if (task.workflow === 'merged' || task.workflow === 'closed') return { ok: true }
    await this.source.browsers?.close(task.id, true)
    task.workflow = 'closed'; task.doneAt = Date.now(); task.outcome = 'done'; task.status = 'done'
    this.save(task); await this.label(task); this.card(task, 'Marked done; nothing merged')
    return { ok: true }
  }
  async remove(task: CoreTask, force = false) { return this.change(task.id, () => this.removeNow(task, force)) }
  private async removeNow(task: CoreTask, force = false) {
    task = this.get(task.id) || (() => { throw new Refusal('No such task') })()
    await this.stopAgents(task)
    const state = await this.held(task)
    if (state.held.length && !force) return { ok: false, held: state.held, stopped: true }
    await this.source.browsers?.close(task.id, true)
    const repo = { machine: task.machine, folder: task.repo }
    if (state.worktree) await this.git.run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), task.folder])
    if (state.branch) {
      const head = await this.git.head(repo, task.branch)
      const safeSquash = task.workflow === 'merged' && head === task.readyHead && task.mergeCommit && await this.git.contains(repo, task.base, task.mergeCommit)
      if (safeSquash) await this.git.run(repo, ['update-ref', '-d', `refs/heads/${task.branch}`, head])
      else await this.git.run(repo, ['branch', force ? '-D' : '-d', task.branch!])
    }
    for (const agent of this.source.agents.all().filter(agent => agent.chat.startsWith(`${task.id}/`))) {
      this.source.store.db.query('DELETE FROM records WHERE kind=? OR kind=?').run(`message:${agent.chat}`, `event:${agent.chat}`)
      this.source.store.delete('agent', agent.chat)
    }
    this.source.store.delete('task', task.id); this.source.emit('snapshot')
    return { ok: true, stopped: true }
  }
  async review(grant: Grant, id: string) { return this.change(id, () => this.reviewNow(grant, id)) }
  private async reviewNow(grant: Grant, id: string) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (!task.review.on) throw new Refusal('Review is off for this task')
    const round = (task.reviewRound ?? 0) + 1
    if (round > task.review.rounds) throw new Refusal('The configured review rounds have been used; report the remaining findings')
    const parent = this.source.agents.get(task.chat), space = this.source.space(task.place)
    if (!parent || !space) throw new Refusal('The task agent must be running before its reviewer starts')
    const reviewHead = await this.git.head({ machine: task.machine, folder: task.folder })
    const reviewer = await this.source.agents.launch(space, `${task.id}/Reviewer-${round}`, task.review.kind,
      `Review commit ${reviewHead} against base ${task.base} and this brief:\n\n${task.desc}\n\nRead repository AGENTS.md, CLAUDE.md and REVIEW.md if present. Find what broke, was omitted or exceeded the brief. Report each finding with proof and critical/major/minor/trivial severity. Do not edit files or decide whether to merge. Finish with your findings as a final reply in your own chat; Shepherdr forwards that native reply to the parent. Do not use hc send or request permission to leave the read-only sandbox for reporting.`,
      { role: 'reviewer', parent, folder: task.folder, task: task.id, readOnly: true, model: task.reviewerModel, effort: task.reviewerEffort, instructions: 'You are a fresh read-only reviewer. Follow repository checks rules. Never edit, commit, merge, or start other agents. Finish with a final reply in your own native chat; the server forwards it to the parent. Never leave the read-only sandbox just to report. Explicit human instructions and the brief win over private/team rules; explain conflicts. Never copy private instructions into git, briefs, reports or GitHub.' })
    task.reviewRound = round; task.reviewTerminal = reviewer.terminal; task.reviewChat = reviewer.chat
    task.reviewHead = reviewHead; delete task.reviewReport; delete task.reviewTurn; delete task.reviewFailure; this.save(task)
    return reviewer.terminal
  }
  /** Metadata only: automatic archiving never kills a process, removes a worktree or erases history. */
  autoArchive(now = Date.now()) {
    if (this.source.quiescing || !this.source.connected()) return 0
    let count = 0
    for (const task of this.all()) {
      if (task.archived || this.busy(task.id) || !['merged', 'closed'].includes(task.workflow) || !this.source.space(task.place)) continue
      const ms = archiveAfterMs(this.source.settings.get('tasks.archiveAfter', task.place))
      if (ms === null || !task.doneAt || now - Math.max(task.doneAt, task.unarchived ?? 0) < ms) continue
      const active = this.source.agents.all().filter(agent => agent.chat.startsWith(`${task.id}/`)).some(agent =>
        this.source.agents.terminal(agent)?.state !== 'finished' && ['starting', 'working', 'blocked'].includes(agent.state))
      if (active) continue
      task.archived = now; delete task.pinned; this.source.store.set('task', task.id, task); count++
    }
    if (count) this.source.emit('snapshot')
    return count
  }
  async tick() {
    if (this.source.quiescing || this.ticking || !this.source.connected()) return
    this.ticking = true
    try {
      this.autoArchive()
      for (const task of this.all()) {
        if (this.changing.has(task.id) || this.merging.has(task.id)) continue
        if (task.reviewChat && !task.reviewTurn) {
          const reviewer = this.source.agents.get(task.reviewChat)
          const end = this.source.store.all<LogEvent>(`event:${task.reviewChat}`).filter(event => event.kind === 'turn-end').at(-1)
          const terminal = reviewer && this.source.agents.terminal(reviewer)
          const completed = reviewer?.transcriptFormat !== 'codex-exec' || terminal?.state === 'finished' && terminal.exit_code === 0
          if (reviewer && task.reviewFailure !== reviewer.launch && (end?.kind === 'turn-end' && end.aborted || reviewer.transcriptFormat === 'codex-exec' && terminal?.state === 'finished' && terminal.exit_code !== 0)) {
            this.source.saveAndDeliver(task.chat, `review-failed-${reviewer.launch}`, '<review-failed>The reviewer stopped without a successful report. Do not treat its partial words as findings or report ready; request another fresh review.</review-failed>', () => {
              task.reviewFailure = reviewer.launch; this.source.store.set('task', task.id, task)
            })
            this.source.emit('snapshot')
          }
          if (reviewer && completed && end?.kind === 'turn-end' && !end.aborted) {
            const messages = this.source.logs.messages(task.reviewChat).filter(message => message.who === 'agent' && message.text && (message.at ?? 0) <= end.at)
            const report = messages.at(-1)
            if (report?.text) {
              this.source.saveAndDeliver(task.chat, `review-${reviewer.launch}-${end.id}`, `<review round="${task.reviewRound}" head="${task.reviewHead}">${report.text}</review>`, () => {
                task.reviewReport = report.text; task.reviewTurn = end.id; this.source.store.set('task', task.id, task)
              })
              this.source.emit('snapshot')
            }
          }
        }
        if (task.archived || task.workflow !== 'queued' || !(task.after ?? []).every(id => ['merged', 'closed'].includes(this.get(id)?.workflow || ''))) continue
        const room = this.source.health?.room(task.machine, task.id)
        if (room) { if (task.capacity !== room) { task.capacity = room; this.save(task) }; continue }
        const agent = this.source.agents.get(task.chat)
        if (agent && (agent.state !== 'idle' || agent.permission)) continue
        await this.change(task.id, async () => {
          task.workflow = 'working'; delete task.capacity; this.save(task)
          try {
            if (agent && this.source.agents.terminal(agent)?.state === 'live') {
              await this.label(task)
              await this.source.agents.send(task.chat, '<go>Your dependencies are done and the machine has room. Begin the agreed brief now.</go>')
            } else await this.launchNow(task)
          } catch (error) { task.workflow = 'todo'; delete task.reservedAt; task.startError = (error as Error).message; this.save(task) }
        })
      }
    } finally { this.ticking = false }
  }

  async cli(grant: Grant, args: string[]): Promise<{ out: string; code: number }> {
    const parsed = parseArgs(args), [verb, sub, ...rest] = parsed.words
    const text = (value: unknown) => ({ out: typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n', code: 0 })
    if (verb === 'task' && sub === 'add') {
      const kind = one(parsed, 'agent')
      if (kind && kind !== 'claude' && kind !== 'codex') throw new Refusal('Choose Claude Code or Codex')
      const task = await this.add(grant, { title: rest.join(' '), brief: one(parsed, 'brief') || '', space: one(parsed, 'space'), base: one(parsed, 'base'),
        after: one(parsed, 'after')?.split(',').filter(Boolean), later: parsed.flags.has('later'), kind: kind as AgentKind | undefined, model: one(parsed, 'model'), effort: one(parsed, 'effort') })
      return text(`${task.id}: ${task.name}\nBranch: ${task.branch}\nWorktree: ${task.folder}\nCore terminal: ${this.source.agents.get(task.chat)?.terminal || 'starting'}`)
    }
    if (verb === 'task' && sub === 'list') return text(this.all().filter(task => this.source.agents.get(grant.chat)?.space === task.place).map(task => this.view(task)))
    const rawId = verb === 'task' ? rest[0] : sub
    const caller = this.source.agents.get(grant.chat)
    const short = this.all().filter(task => task.place === caller?.space && (/^\d+$/.test(rawId || '') ? task.id.endsWith(`-${rawId}`) : task.localId === rawId))
    if (short.length > 1) throw new Refusal('Use the full task ID; this number occurs more than once in the space')
    const id = short[0]?.id || rawId
    const task = id && this.get(id)
    if (!task) throw new Refusal('No such task or unsupported task command')
    this.assert(grant, task)
    if (verb === 'task' && sub === 'show') return text(this.view(task))
    if (verb === 'task' && sub === 'close') return text(await this.close(task, parsed.flags.has('force')))
    if (verb === 'status') {
      const left = one(parsed, 'left'), match = left?.match(/^(?:(\d+)h)?(?:(\d+)m)?$/)
      if (left && (!match || !match[1] && !match[2])) throw new Refusal('Use a time such as 5m or 1h20m')
      await this.report(grant, id, parsed.words.slice(2).join(' '), Number(one(parsed, 'done') ?? 0), match ? Number(match[1] || 0) * 60 + Number(match[2] || 0) : undefined)
      return text('Progress recorded')
    }
    if (verb === 'ready' || verb === 'done') {
      const summary = summaryOpts(parsed, rest)
      await this.ready(grant, id, summary.said || '', summary.facts)
      return text(`${id} is ready`)
    }
    if (verb === 'pr' || verb === 'task' && sub === 'pr') return text(await this.pr(grant, id))
    if (verb === 'checks') return text((await this.git.pullRequest({ machine: task.machine, folder: task.folder }, task.branch!)).statusCheckRollup)
    if (verb === 'review') return text(`Fresh reviewer started: ${await this.review(grant, id)}\nIts native final reply will be forwarded to your chat. Wait for that report before ready; do not read terminal screens as the review result.`)
    if (verb === 'merge' || verb === 'task' && sub === 'merge') return text(`${(await this.merge(grant, id)).id} is merged`)
    if (verb === 'todo') return this.change(id, async () => { task.workflow = 'todo'; delete task.reservedAt; this.save(task); await this.label(task); return text(`${id} is To do`) })
    if (verb === 'task' && sub === 'tell') { await this.source.act({ type: 'send', cid: randomUUID(), chat: task.chat, text: rest.slice(1).join(' ') }); return text('Saved for delivery through core') }
    if (verb === 'task' && sub === 'queue') return this.change(id, async () => {
      if (['merged', 'closed', 'merging'].includes(task.workflow)) throw new Refusal(`${task.id} is already ${task.workflow}; its queue cannot change`)
      const raw = one(parsed, 'after')
      if (!raw?.trim()) throw new Refusal('Choose --after <task IDs>, or --after none')
      const after = taskDependencies(this.all(), task, raw === 'none' ? [] : [raw], machine => this.source.machineName(machine))
      const open = after.filter(id => !['merged', 'closed'].includes(this.get(id)!.workflow))
      const was = task.workflow
      task.after = after
      delete task.readyHead; delete task.approvedHead; delete task.mergeQuestion
      if (open.length) {
        task.workflow = 'queued'; delete task.capacity
        // A queued pause is delivered after the current native turn. Keep that
        // still-live turn in capacity accounting until its status really becomes idle.
        if (was === 'working') task.reservedChats = [...new Set([...(task.reservedChats ?? []), task.chat])]
        this.save(task); await this.label(task); this.card(task, `Queued after ${open.join(', ')}`)
        if (grant.chat !== task.chat && this.source.agents.get(task.chat)) this.source.saveAndDeliver(task.chat, `queue-${randomUUID()}`,
          `<queue>This task now waits for ${open.join(', ')}. Pause implementation and wait for <go>.</queue>`, () => {}, true)
        return text(`Queued after ${open.join(', ')}`)
      }
      // Clearing an already-working task's queue is a no-op for its capacity slot.
      if (was === 'working') { this.save(task); await this.label(task); return text('No dependencies remain') }
      const room = this.source.health?.room(task.machine, task.id)
      const agent = this.source.agents.get(task.chat)
      const live = agent && this.source.agents.terminal(agent)?.state === 'live'
      task.workflow = room || !live ? 'queued' : 'working'
      if (room) task.capacity = room; else delete task.capacity
      if (task.workflow === 'working') task.reservedAt = Date.now()
      this.save(task); await this.label(task)
      if (task.workflow === 'working' && grant.chat !== task.chat) this.source.saveAndDeliver(task.chat, `go-${randomUUID()}`,
        '<go>No dependencies remain and the machine has room. Begin the agreed brief now.</go>', () => {}, true)
      return text(room ? 'Dependencies cleared; wait for <go> when the machine has room' : live ? 'Queue cleared; follow the human’s go' : 'Dependencies cleared; the task will start when its machine has room')
    })
    throw new Refusal('This task command is not implemented in the current slice')
  }
}
