import { Refusal } from './client.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { SUMMARY_MAX, TITLE_MAX, STATUS_MAX, slugify, type Action, type Question, type Task } from '../../shared/types.ts'
import { CoreGit } from './git.ts'
import type { CoreSource } from './source.ts'
import type { AgentKind, CoreSpace } from './model.ts'
import type { Grant } from './mailbox.ts'
import { one, parseArgs, summaryOpts } from '../live/args.ts'

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
  mergeQuestion?: string
  startError?: string
  model?: string
  effort?: string
  mergeCommit?: string
}

/** Workflow is explicit persisted metadata, mirrored to core labels. It is never inferred from process exit. */
export class CoreTasks {
  readonly git: CoreGit
  private ticking = false
  private merging = new Set<string>()
  private drains = new Set<() => void>()
  constructor(private readonly source: CoreSource) { this.git = new CoreGit(source.files) }
  all() { return this.source.store.all<CoreTask>('task') }
  get(id: string) { return this.source.store.get<CoreTask>('task', id) }
  forChat(chat: string) { return this.all().find(task => task.chat === chat || `${task.id}/Reviewer` === chat) }
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
    return { ...task, status, agent: agent ? { chat: task.chat, role: 'Agent', cli: agent.kind, status, age: task.age, note: task.report?.msg || '' } : undefined,
      state: status === 'done' ? task.workflow === 'closed' ? 'Done' : 'Merged' : status === 'ready' ? 'Ready' : status === 'need' ? 'Needs you' : status === 'queued' ? 'Queued' : status === 'todo' ? 'To do' : status === 'merging' ? 'Merging' : 'Working' }
  }
  async add(grant: Grant, input: { title: string; brief: string; space?: string; base?: string; after?: string[]; later?: boolean; kind?: AgentKind; model?: string; effort?: string }) {
    if (!input.title.trim() || input.title.length > TITLE_MAX) throw new Refusal(`Write a title of at most ${TITLE_MAX} characters`)
    if (!input.brief.trim()) throw new Refusal('Give the task its full brief')
    const caller = this.source.agents.get(grant.chat)
    if (caller?.role !== 'coordinator' || caller.grant !== grant.id || caller.launch !== grant.session) throw new Refusal('Only a coordinator can add a task')
    const space = input.space ? this.source.spaces().find(space => space.id === input.space || space.name === input.space && space.machine === caller.machine) : this.source.space(caller.space)
    if (!space || space.home) throw new Refusal('Choose a repository space for the task')
    if (space.machine !== caller.machine) throw new Refusal('Use the coordinator of the task’s machine')
    const number = this.source.store.next(`task:${space.machine}:${space.prefix}`)
    const id = `${space.prefix}-${number}`
    const branch = `work/${number}-${slugify(input.title).slice(0, 40)}`
    const folder = join(this.source.config.home, 'worktrees', space.name, branch.replaceAll('/', '-'))
    const after = input.after ?? []
    for (const dependency of after) if (!this.get(dependency)) throw new Refusal(`No such dependency: ${dependency}`)
    const task: CoreTask = {
      id, name: input.title.trim(), desc: input.brief, place: space.id, machine: space.machine, folder, repo: space.folder, branch, base: input.base || space.base,
      chat: `${id}/Agent`, kind: input.kind || caller.kind, workflow: after.length ? 'queued' : input.later ? 'todo' : 'working', status: after.length ? 'queued' : input.later ? 'todo' : 'work',
      mergePolicy: 'ask', review: { on: true, kind: 'codex', rounds: 3, mustFix: 'major' }, after, age: 'now', created: new Date().toISOString(), on: this.source.snapshot().host, state: 'Working',
    }
    this.save(task) // Number and record survive a failed worktree/agent start; never reuse their branch number.
    try {
      await this.source.files.exec(space.machine, ['mkdir', '-p', join(folder, '..')])
      await this.git.addWorktree({ machine: space.machine, folder: space.folder }, folder, branch, task.base!)
      await this.launch(task, undefined, input.model, input.effort)
    } catch (error) { task.startError = (error as Error).message; task.workflow = 'todo'; this.save(task); throw error }
    this.card(task, task.workflow === 'queued' ? 'Queued after ' + after.join(', ') : task.workflow === 'todo' ? 'Waiting for your go' : 'Started')
    return task
  }
  async launch(task: CoreTask, message?: string, model?: string, effort?: string) {
    const space = this.source.space(task.place)
    if (!space) throw new Refusal('Task space is missing')
    let parent = this.source.agents.get(space.id)
    if (!parent || this.source.agents.terminal(parent)?.state !== 'live') parent = await this.source.agents.launch(space, space.id, task.kind, '')
    const wait = task.workflow === 'queued' ? `This task is queued after ${task.after?.join(', ')}. Read the brief, then wait for <go>. Do not start implementation yet.`
      : task.workflow === 'todo' ? 'Read the brief, then wait for the human’s go. Do not start implementation yet.' : ''
    const role = readFileSync(join(import.meta.dir, '../../skill/shepherdr-agent/SKILL.md'), 'utf8')
    const instructions = `${role}\n\nYou are ${task.id} in standalone Shepherdr on core. Your authenticated shepherdr command is ${join(import.meta.dir, '../../bin/shepherdr')}. Use hc for child agents, messages and waits. Do not use legacy helpers, SSH workers, a web URL or screen scraping. Your branch is ${task.branch}; stay in this worktree.\n`
    const prompt = `${task.desc}\n\n${wait}\n\nSettings:\n- Review: ${task.review.on ? 'on' : 'off'}\n- Reviewer: ${task.review.kind}\n- Must fix: ${task.review.mustFix}\n- Review rounds: ${task.review.rounds}\n- Merge: ask the human first\n${message ? `\n<go>${message}</go>` : ''}`
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
  async ready(grant: Grant, id: string, summary: string, facts?: string) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (!summary.trim() || summary.length > SUMMARY_MAX) throw new Refusal(`Write a summary of at most ${SUMMARY_MAX} characters`)
    if (!await this.git.clean({ machine: task.machine, folder: task.folder })) throw new Refusal('Commit or remove the worktree changes before reporting ready')
    task.readyHead = await this.git.head({ machine: task.machine, folder: task.folder })
    task.said = summary; task.facts = facts; task.workflow = 'ready'
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
    const request = this.source.store.get<{ task: string; head: string }>('merge-question', question)
    if (!request) return false
    const task = this.get(request.task)
    if (!task || task.chat !== chat || task.mergeQuestion !== question || task.workflow !== 'ready') throw new Refusal('This merge request is no longer current')
    if (choice !== 0 && choice !== 1) throw new Refusal('Choose Merge or Not yet')
    if (choice === 0) {
      const head = await this.git.head({ machine: task.machine, folder: task.folder })
      if (head !== request.head) throw new Refusal('The task changed after this request; ask for a fresh ready report')
      task.approvedHead = head
    }
    this.source.store.delete('merge-question', question)
    const message = this.source.store.get<{ question: Question }>(`message:${chat}`, question)
    if (message) this.source.post(chat, { ...message, id: question, who: 'agent', question: { ...message.question, sent: choice }, at: Date.now() })
    this.save(task)
    await this.source.agents.send(chat, `<answer question="Merge ${task.id}?">${choice === 0 ? 'Merge' : 'Not yet'}</answer>`)
    return true
  }
  async merge(grant: Grant, id: string) {
    if (this.source.quiescing) throw new Refusal('Shepherdr is stopping; retry after it restarts')
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (task.workflow === 'merged') return task
    if (this.merging.has(id)) throw new Refusal('This merge is already in progress')
    if (this.all().some(other => other.id !== id && other.machine === task.machine && other.repo === task.repo && this.merging.has(other.id))) throw new Refusal('Another task is merging into this repository; retry after it finishes')
    this.merging.add(id)
    try {
      const worktree = { machine: task.machine, folder: task.folder }, repo = { machine: task.machine, folder: task.repo }
      const head = await this.git.head(worktree)
      if (!task.readyHead || head !== task.readyHead) throw new Refusal('Report this exact commit ready before merging')
      if (task.mergePolicy === 'ask' && task.approvedHead !== head) throw new Refusal('The human must approve this commit using its merge card first')
      if (!await this.git.clean(worktree)) throw new Refusal('The worktree has uncommitted work')
      task.workflow = 'merging'; this.save(task); await this.label(task)
      const remote = await this.git.remote(repo)
      if (remote) {
        const pr = await this.git.pullRequest(worktree, task.branch!)
        if (pr.headRefOid !== head || pr.baseRefName !== task.base) throw new Refusal('The pull request head or base differs from the approved task')
        if (pr.state !== 'MERGED') {
          if (pr.statusCheckRollup.some(check => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion || check.state || 'PENDING'))) throw new Refusal('GitHub checks are not green')
          await this.source.files.exec(task.machine, ['gh', 'pr', 'merge', String(pr.number), '--squash', '--match-head-commit', head, '--repo', remote], task.folder, undefined, 90)
        }
        const done = await this.git.pullRequest(worktree, task.branch!)
        if (done.state !== 'MERGED') throw new Refusal('GitHub has not confirmed the merge')
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
          task.mergeCommit = (await this.source.files.exec(task.machine, ['git', 'commit-tree', tree, '-p', base, '-F', '-'], task.repo, Buffer.from(message))).toString('utf8').trim()
          this.save(task) // Persist the prepared commit before the only base-ref/worktree change.
          await this.git.run(repo, ['merge', '--ff-only', task.mergeCommit])
        }
      }
      task.workflow = 'merged'; task.status = 'done'; task.doneAt = Date.now(); task.outcome = 'done'
      this.save(task); await this.label(task); this.card(task, task.said || 'Merged')
      return task
    } finally {
      this.merging.delete(id)
      if (!this.merging.size) { for (const resolve of this.drains) resolve(); this.drains.clear() }
    }
  }
  async drain() {
    const waiting = this.merging.size > 0
    if (waiting) await new Promise<void>(resolve => this.drains.add(resolve))
    return waiting
  }
  async pr(grant: Grant, id: string) {
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
      await this.source.files.exec(task.machine, ['gh', 'pr', 'create', '--draft', '--base', task.base!, '--head', task.branch!, '--title', `${task.id}: ${task.name}`, '--body-file', '-'], task.folder, Buffer.from(task.said || task.desc || task.name), 60)
      pr = await this.git.pullRequest(repo, task.branch!)
    }
    task.pr = { number: pr.number, url: pr.url }; this.save(task)
    return task.pr
  }
  async report(grant: Grant, id: string, message: string, progress: number, eta?: number) {
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
    if (this.merging.has(task.id) && !['pin', 'restart-info'].includes(action.type)) throw new Refusal('The merge must finish before changing this task')
    const agent = this.source.agents.get(task.chat), terminal = agent && this.source.agents.terminal(agent)
    switch (action.type) {
      case 'pin': task.pinned = action.on ? Date.now() : undefined; this.save(task); return { ok: true }
      case 'archive':
        if (action.on && terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
        task.archived = action.on ? Date.now() : undefined; this.save(task); return { ok: true }
      case 'pause':
        if (terminal?.state === 'live') await this.source.core.call('terminal.interrupt', { terminal: terminal.address })
        task.workflow = 'todo'; this.save(task); await this.label(task); return { ok: true }
      case 'restart-info': return { ok: true, info: { role: 'task', space: task.place, on: { kind: agent?.kind ?? task.kind, model: agent?.model, effort: agent?.effort }, onKnown: !!agent,
        onWords: agent?.kind ?? task.kind, want: { kind: task.kind, model: task.model, effort: task.effort }, working: agent?.state === 'working',
        clis: [{ kind: 'claude', name: 'Claude Code' }, { kind: 'codex', name: 'Codex' }] } }
      case 'restart':
        if (action.kind && action.kind !== 'claude' && action.kind !== 'codex') throw new Refusal('Choose Claude Code or Codex')
        if (terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
        task.kind = action.kind as AgentKind || task.kind; task.model = action.model || undefined; task.effort = action.effort || undefined
        delete task.startError; this.save(task)
        await this.launch(task, 'Continue your agreed task. Preserve existing work.', task.model, task.effort)
        return { ok: true }
      case 'close': return this.close(task, !!action.force)
      case 'delete': return this.remove(task, !!action.force)
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
    if (head && !await this.git.contains(repo, task.base!, head)) held.push('unmerged commits')
    return { held, worktree: !!block, branch: !!head }
  }
  private async stopAgents(task: CoreTask) {
    for (const agent of this.source.agents.all().filter(agent => agent.chat.startsWith(`${task.id}/`))) {
      const terminal = this.source.agents.terminal(agent)
      if (terminal?.state === 'live') await this.source.core.call('terminal.kill', { terminal: terminal.address })
      this.source.mailbox.revoke(agent.chat)
    }
  }
  async close(task: CoreTask, force = false) {
    const { held } = await this.held(task)
    if (held.length && !force) return { ok: false, held }
    await this.stopAgents(task)
    task.workflow = 'closed'; task.doneAt = Date.now(); task.outcome = 'done'; task.status = 'done'
    this.save(task); await this.label(task); this.card(task, 'Marked done; nothing merged')
    return { ok: true }
  }
  async remove(task: CoreTask, force = false) {
    await this.stopAgents(task)
    const state = await this.held(task)
    if (state.held.length && !force) return { ok: false, held: state.held, stopped: true }
    const repo = { machine: task.machine, folder: task.repo }
    if (state.worktree) await this.git.run(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), task.folder])
    if (state.branch) await this.git.run(repo, ['branch', force ? '-D' : '-d', task.branch!])
    for (const agent of this.source.agents.all().filter(agent => agent.chat.startsWith(`${task.id}/`))) {
      this.source.store.db.query('DELETE FROM records WHERE kind=? OR kind=?').run(`message:${agent.chat}`, `event:${agent.chat}`)
      this.source.store.delete('agent', agent.chat)
    }
    this.source.store.delete('task', task.id); this.source.emit('snapshot')
    return { ok: true, stopped: true }
  }
  async review(grant: Grant, id: string) {
    const task = this.get(id)
    if (!task) throw new Refusal('No such task')
    this.assert(grant, task)
    if (!task.review.on) throw new Refusal('Review is off for this task')
    const round = (task.reviewRound ?? 0) + 1
    if (round > task.review.rounds) throw new Refusal('The configured review rounds have been used; report the remaining findings')
    const parent = this.source.agents.get(task.chat), space = this.source.space(task.place)
    if (!parent || !space) throw new Refusal('The task agent must be running before its reviewer starts')
    const reviewer = await this.source.agents.launch(space, `${task.id}/Reviewer-${round}`, task.review.kind,
      `Review the current change against this brief:\n\n${task.desc}\n\nRead repository AGENTS.md, CLAUDE.md and REVIEW.md if present. Find what broke, was omitted or exceeded the brief. Report each finding with proof and critical/major/minor/trivial severity. Do not edit files or decide whether to merge. Send your findings to your parent with hc send ${parent.terminal}.`,
      { role: 'reviewer', parent, folder: task.folder, task: task.id, readOnly: true, instructions: 'You are a fresh read-only reviewer. Follow repository checks rules. Never edit, commit, merge, or start other agents. Use hc to report to the parent. Explicit human instructions and the brief win over private/team rules; explain conflicts. Never copy private instructions into git, briefs, reports or GitHub. Reviewer private instructions: none.' })
    task.reviewRound = round; task.reviewTerminal = reviewer.terminal; this.save(task)
    return reviewer.terminal
  }
  async tick() {
    if (this.ticking || !this.source.connected()) return
    this.ticking = true
    try {
      for (const task of this.all()) {
        if (task.workflow !== 'queued' || !task.after?.every(id => ['merged', 'closed'].includes(this.get(id)?.workflow || ''))) continue
        const agent = this.source.agents.get(task.chat)
        if (!agent || agent.state !== 'idle' || agent.permission) continue
        task.workflow = 'working'; this.save(task); await this.label(task)
        await this.source.agents.send(task.chat, '<go>Your dependencies are done. Begin the agreed brief now.</go>')
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
    const id = verb === 'task' ? rest[0] : sub
    const task = id && this.get(id)
    if (!task) throw new Refusal('No such task or unsupported task command')
    this.assert(grant, task)
    if (verb === 'task' && sub === 'show') return text(task)
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
    if (verb === 'review') return text(await this.review(grant, id))
    if (verb === 'merge' || verb === 'task' && sub === 'merge') return text(`${(await this.merge(grant, id)).id} is merged`)
    if (verb === 'todo') { task.workflow = 'todo'; this.save(task); await this.label(task); return text(`${id} is To do`) }
    if (verb === 'task' && sub === 'tell') { await this.source.agents.send(task.chat, rest.slice(1).join(' ')); return text('Sent through core') }
    if (verb === 'task' && sub === 'queue') {
      const after = one(parsed, 'after')
      if (after === 'none') { task.after = []; task.workflow = 'working'; this.save(task); await this.label(task); return text('Queue cleared; follow the human’s go') }
      task.after = after?.split(',').filter(Boolean) ?? []; task.workflow = 'queued'; this.save(task); await this.label(task); return text('Queued')
    }
    throw new Refusal('This task command is not implemented in the current slice')
  }
}
