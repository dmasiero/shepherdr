// fork: task commands for scripts (FORK.md). Trusted scripts on the main machine add, list, show and tell tasks
// through the private operator socket (operator.ts), never a web route or an agent's mailbox. A brief or a message
// comes on stdin, so its length is not bound by the socket's command-word limits.
import { randomUUID } from 'node:crypto'
import { Refusal } from './client.ts'
import { one, parseArgs, type Parsed } from '../common/args.ts'
import { coreSpaceName, findCoreSpace } from './space-names.ts'
import { taskOptions } from './task-options.ts'
import { kindOf } from './settings.ts'
import type { CoreSource } from './source.ts'
import type { CoreTask } from './tasks.ts'

const VERBS = ['add', 'list', 'show', 'tell']
const USAGE = 'Use task add TITLE --space NAME [--after IDS] [--later] [--set KEY=VALUE] < brief, task list [--json] [--archived] [--space NAME], task show ID [--json], or task tell ID < message'

export function isOperatorTask(args: string[]) { return args[0] === 'task' && VERBS.includes(args[1]!) }

function only(parsed: Parsed, opts: string[], flags: string[]) {
  const opt = Object.keys(parsed.opts).find(name => !opts.includes(name)), flag = [...parsed.flags].find(name => !flags.includes(name))
  if (opt || flag) throw new Refusal(`${USAGE}. Not --${opt ?? flag}.`)
}

/** Called only by the private, local operator socket: tasks of the main machine's spaces. */
export async function operatorTask(source: CoreSource, args: string[], stdin?: string): Promise<string> {
  const parsed = parseArgs(args), [, verb, ...rest] = parsed.words
  const machine = source.localMachineId()
  const local = () => source.tasks.all().filter(task => task.machine === machine && source.space(task.place))
  const spaceOf = (name: string) => {
    const space = findCoreSpace(source, machine, name)
    if (!space || space.home) throw new Refusal(`No repository space ${name} on the main machine`)
    return space
  }
  const row = (task: CoreTask) => {
    const view = source.tasks.view(task), space = source.space(task.place)
    return { id: task.id, title: task.name, status: view.status, state: view.state, space: space ? coreSpaceName(source, space) : task.place,
      ...(task.archived ? { archived: task.archived } : {}) }
  }
  const find = (id: string) => {
    const task = local().find(task => task.id === id)
    if (!task) throw new Refusal(`No task ${id} on the main machine`)
    return task
  }

  if (verb === 'add') {
    if (parsed.opts.brief || parsed.opts.desc) throw new Refusal('Give the brief on stdin, never in command words')
    const settings = taskOptions(parsed)
    const name = one(parsed, 'space')
    if (!name) throw new Refusal('Choose the task’s space with --space NAME')
    const brief = stdin ?? ''
    if (!brief.trim()) throw new Refusal('Give the task its full brief on stdin')
    const agentName = one(parsed, 'agent'), reviewerName = one(parsed, 'reviewer')
    const kind = agentName === undefined ? undefined : kindOf(agentName), reviewer = reviewerName === undefined ? undefined : kindOf(reviewerName)
    if (agentName !== undefined && !kind || reviewerName !== undefined && !reviewer) throw new Refusal('Choose Claude Code or Codex')
    const task = await source.tasks.addInSpace(spaceOf(name), { title: rest.join(' '), brief, base: one(parsed, 'base'),
      after: one(parsed, 'after')?.split(',').map(id => id.trim()).filter(Boolean), later: parsed.flags.has('later'),
      kind, model: one(parsed, 'model'), effort: one(parsed, 'effort'), reviewer, reviewerModel: one(parsed, 'reviewer-model'), reviewerEffort: one(parsed, 'reviewer-effort'), settings })
    // 2.0's first line, which the dispatchers read (shepherdr_board.py).
    const start = task.workflow === 'queued' ? `waits for ${task.after?.join(', ') || 'room on the machine'}` : task.workflow === 'todo' ? 'waits for a go' : 'starts on the brief now'
    return `Added ${task.id}: ${task.name}. Its agent ${start}.\nBranch: ${task.branch}\n`
  }
  if (verb === 'list') {
    only(parsed, ['space'], ['json', 'archived'])
    const archived = parsed.flags.has('archived'), selected = one(parsed, 'space')
    const place = selected ? spaceOf(selected).id : undefined
    const rows = local().filter(task => !!task.archived === archived && (!place || task.place === place)).map(row)
    if (parsed.flags.has('json')) return JSON.stringify(rows) + '\n'
    return rows.map(item => `${item.id} · ${item.state} · ${item.space} · ${item.title}`).join('\n') + (rows.length ? '\n' : 'No tasks.\n')
  }
  if (verb === 'show') {
    only(parsed, [], ['json'])
    if (rest.length !== 1) throw new Refusal(USAGE)
    const task = find(rest[0]!), value = { ...row(task), branch: task.branch, base: task.base, ...(task.pr ? { pr: task.pr } : {}) }
    if (parsed.flags.has('json')) return JSON.stringify(value) + '\n'
    return `${value.id}: ${value.title}\nState: ${value.state} · ${value.space}\nBranch: ${value.branch}${value.pr ? `\nPull request: ${value.pr.url}` : ''}\n`
  }
  if (verb === 'tell') {
    only(parsed, [], [])
    if (rest.length !== 1) throw new Refusal('Use task tell ID < message: the message on stdin')
    const task = find(rest[0]!)
    // A message to a Done or archived task would start it again in a fresh worktree; scripts add a new task instead.
    if (task.archived || ['merged', 'closed'].includes(task.workflow)) throw new Refusal(`${task.id} is ${task.archived ? 'archived' : 'Done'}; add a new task instead`)
    const text = stdin ?? ''
    if (!text.trim()) throw new Refusal('Give the message on stdin')
    await source.act({ type: 'send', cid: randomUUID(), chat: task.chat, text })
    return `Told ${task.id}.\n`
  }
  throw new Refusal(USAGE)
}
