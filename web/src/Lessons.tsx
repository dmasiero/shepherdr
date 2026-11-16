// fork: SHEP-67: Agents that learn, step 5 of 5 (designed in SHEP-62). Settings › Agents › Lessons, as the window's
// (mods/shepherdr-settings/lessons-section.js): under the Lessons switch, how much of a brief's budget the kept lessons
// use here, then each one with the tasks it came from, when it was kept and how often it went into a brief; Edit and
// Retire run `herdr-task lessons edit|retire` (service/actions.ts lessonAct). A space's page lists Everywhere's too,
// folded. And the Accept card's "n lessons" chip: the drafts waiting for the person, each with Keep, Edit and Drop.
// Every word is core/settings.js's LESSONS, the window's own.
import clsx from 'clsx'
import { useState } from 'react'
import type { KeptLesson, LessonsView } from '@shared/types.ts'
import * as STc from '@core/settings.js'
import { act, openTask, setUI, taskOf, useSnap } from './kernel.ts'
import { DownIcon, Ghost, NextIcon, Small, TextBox } from './ui.tsx'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const L = (STc as any).LESSONS

type Said = { ok?: boolean; error?: string }
async function lessonAct(what: string, id: string, extra: Record<string, string> = {}): Promise<string> {
  try {
    const r = (await act({ type: 'lesson', what, id, ...extra } as never)) as Said
    return r?.ok === false ? r.error ?? 'Refused.' : ''
  } catch (e) {
    let m = e instanceof Error ? e.message : 'That did not save. Try again.'
    try { const body = JSON.parse(m); if (typeof body.error === 'string') m = body.error } catch {}
    return m
  }
}

/** a task it came from: opens it where the app still has it, else just its name */
function TaskChip({ name }: { name: string }) {
  const snap = useSnap()
  const id = snap && (taskOf(snap, name) ? name : snap.tasks.find((t) => t.id.endsWith(`:${name}`))?.id)
  const look = 'inline-flex h-5 shrink-0 items-center rounded-full bg-bubble px-1.5 font-mono text-[0.6875rem] text-fg2 phone:h-6 phone:text-[0.75rem]'
  if (!id) return <span className={look}>{name}</span>
  return (
    <button type="button" onClick={() => { setUI({ settings: null }); openTask(id) }} className={clsx(look, 'press-dim hover:text-fg')}>
      {name}
    </button>
  )
}

/** a box for a lesson's new words, Save and Cancel */
function EditBox({ text, busy, onSave, onCancel }: { text: string; busy: boolean; onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(text)
  return (
    <div className="flex flex-col gap-2">
      <TextBox label={L.edit} value={v} onChange={setV} autoFocus maxLength={400}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(v) } else if (e.key === 'Escape') onCancel() }}
        className="w-full rounded-box bg-bg px-3 py-2 text-pretty shadow-[inset_0_0_0_1px_var(--line2)] focus:shadow-box-focus focus:outline-none" />
      <span className="flex justify-end gap-1.5">
        <Ghost onClick={onCancel}>{L.cancel}</Ghost>
        <Ghost disabled={busy || !v.trim() || v.trim() === text} onClick={() => onSave(v)} className="font-medium text-fg">{L.save}</Ghost>
      </span>
    </div>
  )
}

/** one kept lesson: its words, where it came from, kept when and seen how often; Edit and Retire */
function Lesson({ x, phone, dim }: { x: KeptLesson; phone: boolean; dim?: boolean }) {
  const [mode, setMode] = useState<'' | 'edit' | 'retire'>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (what: string, extra: Record<string, string> = {}) => {
    setBusy(true); setError('')
    const said = await lessonAct(what, x.id, extra)
    setBusy(false); setError(said)
    if (!said) setMode('')
  }
  const meta = [L.kept(x.keptAt), x.seen ? L.seen(x.seen) : '', x.edited ? L.edited : ''].filter(Boolean)
  return (
    <li data-lesson={x.id} className={clsx('relative flex flex-col gap-1.5', phone ? 'px-4 py-3 not-first:before:absolute not-first:before:inset-x-0 not-first:before:top-0 not-first:before:left-4 not-first:before:h-px not-first:before:bg-line' : 'py-3 not-first:border-t not-first:border-line')}>
      {mode === 'edit' ? (
        <EditBox text={x.text} busy={busy} onCancel={() => { setMode(''); setError('') }} onSave={(v) => void run('edit', { text: v.trim() })} />
      ) : (
        <p className={clsx('text-pretty [overflow-wrap:anywhere]', (dim || x.left) && 'text-fg2')}>{x.text}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-[0.75rem] text-fg3 tabular-nums phone:text-[0.8125rem]">
          {x.from.map((r) => <TaskChip key={r} name={r} />)}
          <span className="whitespace-nowrap">{x.from.length ? '· ' : ''}{meta.join(' · ')}</span>
        </span>
        {mode === '' ? (
          <span className="flex shrink-0 gap-1.5">
            <Ghost onClick={() => setMode('edit')}>{L.edit}</Ghost>
            <Ghost onClick={() => setMode('retire')}>{L.retire}</Ghost>
          </span>
        ) : null}
      </div>
      {x.left ? <Small className="text-pretty text-fg3!">{x.left === 'same' ? L.same : L.left}</Small> : null}
      {mode === 'retire' ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Small className="min-w-0 flex-1 text-pretty">{L.retireAsk}</Small>
          <Ghost onClick={() => setMode('')}>{L.cancel}</Ghost>
          <Ghost disabled={busy} onClick={() => void run('retire')} className="font-medium text-need-fg">{L.retire}</Ghost>
        </div>
      ) : null}
      {error ? <Small role="alert" className="text-pretty text-need-fg!">{error}</Small> : null}
    </li>
  )
}

/** Settings › Agents › Lessons' list, under its switch (card: a phone's grouped rows) */
export function LessonsList({ view, space, phone, card }: { view: LessonsView; space: boolean; phone: boolean; card: string }) {
  const [open, setOpen] = useState(false)
  const line = clsx('text-pretty', phone ? 'px-4 text-[0.9375rem]' : 'text-[0.8125rem]')
  const list = (xs: KeptLesson[], dim?: boolean) => (
    <ul role="list" className={clsx(phone ? card : 'border-y border-line', 'flex flex-col')}>
      {xs.map((x) => <Lesson key={x.id} x={x} phone={phone} dim={dim} />)}
    </ul>
  )
  return (
    <section aria-label={L.title} className="-mt-3 flex w-full flex-col gap-2.5">
      <p className={clsx(line, view.on ? 'text-fg2 tabular-nums' : 'text-fg3')}>{view.on ? L.budget(view.n, view.chars) : L.off}</p>
      {view.own.length ? list(view.own) : <p className={clsx(line, 'text-fg3')}>{space ? L.noneHere : L.none}</p>}
      {view.retired ? <p className={clsx(line, 'text-fg3')}>{L.retired(view.retired)}</p> : null}
      {space && view.inherited.length ? (
        <div className="flex flex-col gap-2">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={clsx('press-dim flex items-center gap-1.5 self-start font-medium text-fg2 hover:text-fg', phone ? 'px-4 text-[0.9375rem]' : 'text-[0.8125rem]')}>
            {open ? <DownIcon className="size-3.5 shrink-0" /> : <NextIcon className="size-3.5 shrink-0" />}
            {L.inherited(view.inherited.length)}
          </button>
          {open ? list(view.inherited, true) : null}
        </div>
      ) : null}
    </section>
  )
}

export type Waiting = { id: string; text: string; scope: string }

/** one draft on the Accept card: its words and who reads it, Keep, Edit and Drop */
function Draft({ x, task }: { x: Waiting; task: string }) {
  const [done, setDone] = useState<'' | 'kept' | 'dropped'>('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [text, setText] = useState(x.text)
  const run = async (what: string, extra: Record<string, string> = {}) => {
    setBusy(true); setError('')
    const said = await lessonAct(what, x.id, { task, ...extra })
    setBusy(false); setError(said)
    if (!said) { setDone(what === 'drop' ? 'dropped' : 'kept'); setEditing(false); if (extra.text) setText(extra.text) }
  }
  return (
    <li data-draft={x.id} className="flex flex-col gap-1.5 py-2.5 not-first:border-t not-first:border-line">
      {editing ? (
        <EditBox text={text} busy={busy} onCancel={() => { setEditing(false); setError('') }} onSave={(v) => void run('edit', { text: v.trim() })} />
      ) : (
        <p className={clsx('text-pretty [overflow-wrap:anywhere]', done === 'dropped' && 'text-fg3 line-through')}>{text}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className="min-w-0 flex-1 text-[0.75rem] text-fg3 phone:text-[0.8125rem]">{L.who[x.scope] ?? x.scope}</span>
        {done ? (
          <span className={clsx('text-[0.8125rem] font-medium', done === 'kept' ? 'text-ready-fg' : 'text-fg3')}>{done === 'kept' ? L.kept1 : L.dropped}</span>
        ) : editing ? null : (
          <span className="flex shrink-0 gap-1.5">
            <Ghost disabled={busy} onClick={() => void run('keep')} className="font-medium text-fg">{L.keep}</Ghost>
            <Ghost disabled={busy} onClick={() => setEditing(true)}>{L.edit}</Ghost>
            <Ghost disabled={busy} onClick={() => void run('drop')}>{L.drop}</Ghost>
          </span>
        )}
      </div>
      {error ? <Small role="alert" className="text-pretty text-need-fg!">{error}</Small> : null}
    </li>
  )
}

/** The Accept card's "2 lessons" chip, under the summary: opens the drafts to answer while looking at the task (the
 *  Assistant's question card stays the fallback) */
export function LessonsChip({ task, waiting }: { task: string; waiting: Waiting[] }) {
  const [open, setOpen] = useState(false)
  if (!waiting.length) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className="press-dim inline-flex h-7 items-center gap-1 self-start rounded-full bg-bubble pr-2.5 pl-2 text-[0.8125rem] font-medium text-fg hover:bg-hover phone:h-9 phone:text-[0.875rem]">
        {open ? <DownIcon className="size-3.5 shrink-0 text-fg3" /> : <NextIcon className="size-3.5 shrink-0 text-fg3" />}
        {L.waiting(waiting.length)}
      </button>
      {open ? (
        <div className="flex flex-col gap-1">
          <Small className="text-pretty text-fg3!">{L.waitingAbout}</Small>
          <ul role="list" className="flex flex-col">{waiting.map((x) => <Draft key={x.id} x={x} task={task} />)}</ul>
        </div>
      ) : null}
    </div>
  )
}
