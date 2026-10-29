// An agent's activity, from its log's events: each turn's steps (a few rows in plain words in the chat), the turn it is on now,
// and the work it started in the background that still runs. Raw output, and a background job's own steps, are read
// only when the human opens them, from where they are: a line of a log, a shell's output file, a subagent's own log.
import { closeSync, openSync, readdirSync, readlinkSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Step } from '../../shared/types.ts'
import type { Headless } from './readers/background.ts'
import { claudeHome, claudeProjectDir, codexHome } from './readers/find.ts'
import { ClaudeReader, CodexReader, LogTail } from './readers/index.ts'
import type { LogEvent, OutputAt } from './readers/types.ts'

import { activityOf, cutOutput, outputFromLine, shown, type JobRec } from '../activity.ts'
export { activityOf, lineOf, shown, cutOutput } from '../activity.ts'
export type { StepRec, Turn, JobRec } from '../activity.ts'

/* ---------- reading what was left in files ---------- */

const MAX_LINE = 8 << 20

/** the line of a file that starts at this offset */
export function lineAt(file: string, offset: number): string | undefined {
  let fd: number
  try {
    fd = openSync(file, 'r')
  } catch {
    return undefined
  }
  try {
    const parts: Buffer[] = []
    let pos = offset
    let size = 0
    while (size < MAX_LINE) {
      const buf = Buffer.alloc(64 << 10)
      const got = readSync(fd, buf, 0, buf.length, pos)
      if (got <= 0) break
      const nl = buf.subarray(0, got).indexOf(10)
      parts.push(buf.subarray(0, nl < 0 ? got : nl))
      size += nl < 0 ? got : nl
      if (nl >= 0) break
      pos += got
    }
    return Buffer.concat(parts).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** the last bytes of a file, from a whole line on */
export function tailOf(file: string, bytes = 32 << 10): string | undefined {
  let fd: number
  try {
    const size = statSync(file).size
    fd = openSync(file, 'r')
    try {
      const from = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - from)
      const got = readSync(fd, buf, 0, buf.length, from)
      const text = buf.subarray(0, got).toString('utf8')
      return from ? text.slice(text.indexOf('\n') + 1) : text
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g

/** the last line a shell printed, for a background job's line */
export function lastLine(file: string): string | undefined {
  const t = tailOf(file, 4096)
  const l = t?.replace(ANSI, '').split('\n').map((x) => x.trim()).filter(Boolean).at(-1)
  return l ? (l.length > 120 ? `${l.slice(0, 119)}…` : l) : undefined
}

export function outputAt(where: OutputAt, id: string): string | undefined {
  const raw = lineAt(where.file, where.offset)
  return raw ? outputFromLine(raw, id) : undefined
}

/* ---------- a background job's own log ---------- */

/** Codex's log of a thread (a subagent's), by its id: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl */
export function codexThreadLog(id: string): string | undefined {
  const root = join(codexHome(), 'sessions')
  const ls = (d: string) => {
    try {
      return readdirSync(d).sort().reverse()
    } catch {
      return []
    }
  }
  // newest days first: a subagent runs now
  for (const y of ls(root).slice(0, 2))
    for (const m of ls(join(root, y)).slice(0, 2))
      for (const d of ls(join(root, y, m)).slice(0, 3)) {
        const f = ls(join(root, y, m, d)).find((n) => n.endsWith(`${id}.jsonl`))
        if (f) return join(root, y, m, d, f)
      }
  return undefined
}

/** each job's own log, read on as it grows: its steps, and the step it is on */
export class JobLogs {
  private logs = new Map<string, { tail: LogTail; ev: LogEvent[]; used: number }>()

  /** its steps so far (the newest `max`), and how many came before them */
  steps(file: string, max = 300): { steps: Step[]; more?: number } {
    const { turns, open } = activityOf(this.read(file))
    const all = [...turns, ...(open ? [open] : [])].flatMap((t) => t.steps)
    return { steps: all.slice(-max).map(shown), more: all.length > max ? all.length - max : undefined }
  }

  /** the step it is on now, in words */
  now(file: string): string | undefined {
    const ev = this.read(file)
    const s = ev.findLast((e) => e.kind === 'step')
    if (!s || s.kind !== 'step') return undefined
    const over = s.end !== undefined || ev.some((e) => e.kind === 'step-end' && e.id === s.id)
    return over ? s.title : s.doing
  }

  private read(file: string): LogEvent[] {
    let l = this.logs.get(file)
    if (!l) {
      const reader = file.includes('/subagents/') ? new ClaudeReader(true) : file.startsWith(codexHome()) ? new CodexReader() : new ClaudeReader(true)
      l = { tail: new LogTail(file, reader), ev: [], used: 0 }
      this.logs.set(file, l)
      // a few logs at a time: the oldest read goes
      if (this.logs.size > 40) this.logs.delete(this.logs.keys().next().value!)
    }
    l.used = Date.now()
    // a piece at a time: a long log is read on over the next looks (the chat looks once a second)
    const fresh = l.tail.read(4 << 20)
    if (fresh.length) l.ev.push(...fresh.filter((e) => e.kind === 'step' || e.kind === 'step-end' || e.kind === 'turn-start' || e.kind === 'turn-end'))
    return l.ev
  }
}

/* ---------- a headless agent it runs ---------- */

/** the log a headless CLI writes: the one it holds open, else (Claude Code writes and closes) the newest in its
 *  folder's project since it started that isn't its agent's own */
function headlessLog(h: Headless, own: string[]): string | undefined {
  if (!h.pid) return undefined
  const ours = (f: string) => f.endsWith('.jsonl') && (f.startsWith(join(codexHome(), 'sessions')) || f.startsWith(join(claudeHome(), 'projects')))
  try {
    for (const fd of readdirSync(`/proc/${h.pid}/fd`)) {
      try {
        const f = readlinkSync(`/proc/${h.pid}/fd/${fd}`)
        if (ours(f)) return f
      } catch {
        /* closed meanwhile */
      }
    }
    const dir = claudeProjectDir(readlinkSync(`/proc/${h.pid}/cwd`))
    let best: { f: string; t: number } | undefined
    for (const n of readdirSync(dir)) {
      const f = join(dir, n)
      if (!n.endsWith('.jsonl') || own.includes(f)) continue
      const t = statSync(f).mtimeMs
      if (t >= h.at - 5000 && (!best || t > best.t)) best = { f, t }
    }
    return best?.f
  } catch {
    return undefined
  }
}

/** what it is in a few words: "codex exec: Review this change…" */
function headlessTitle(argv: string[]): string {
  const at = argv.findIndex((a) => /(^|\/)(codex|claude|pi)(\.(js|mjs|cjs))?$/.test(a))
  const cli = (argv[at] ?? 'agent').split('/').at(-1)!.replace(/\.(js|mjs|cjs)$/, '')
  const how = cli === 'codex' ? 'exec' : '-p'
  // its prompt: its longest word that is no flag
  const prompt = argv
    .slice(at + 1)
    .filter((a) => !a.startsWith('-') && a.length > 12)
    .sort((a, b) => b.length - a.length)[0]
  const words = prompt?.replace(/\s+/g, ' ').trim()
  return `${cli} ${how}${words ? `: ${words.length > 60 ? `${words.slice(0, 59)}…` : words}` : ''}`
}

/** a headless CLI its agent runs (a reviewer), as background work; its log, where it can be found, gives its steps */
export function headlessJob(h: Headless, own: string[]): JobRec {
  const log = headlessLog(h, own)
  return { id: `headless-${h.pid ?? h.argv.join(' ').slice(0, 60)}`, kind: 'headless', title: headlessTitle(h.argv), at: h.at, log, more: log ? 'steps' : undefined }
}
