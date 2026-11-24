// fork: Ready card after chat replies. A task's menu had one Mark as done, which closes it without merging ("Done · not
// merged"): a task with its pull request open became Done with that pull request left open, with no word. Such a task's
// menu now has Mark as done and merge first (herdr-task accept: merged when its checks pass and it can merge, else
// refused in plain words), and Done, not merged after it, the explicit choice. Others keep the one Mark as done.
import type { Task } from '@shared/types.ts'

/** a task's menu rows that end it: what each runs, accept (merge) or close (done without merging) */
export function doneRows(t: Pick<Task, 'pr'>, state: string): { label: string; how: 'accept' | 'close' }[] {
  if (state === 'done' || state === 'archived') return []
  if (t.pr && !t.pr.closed) return [{ label: 'Mark as done and merge', how: 'accept' }, { label: 'Done, not merged', how: 'close' }]
  return [{ label: 'Mark as done', how: 'close' }]
}
