// fork: Terminal across fold/unfold. Your own terminal lives in two places: the drawer under the chat or a task on a
// wide screen (`term`, `tterm`), the whole-screen Terminal pane on a phone (`pane: 'terminal'`, `termTask`). A fold or
// an unfold (the width crossing the phone's 767 px) switched layouts without carrying one over to the other, so the
// folded phone showed no terminal, and one opened there came back as a second terminal beside the drawer. Now the
// open terminal moves across: at most one, the same shell, in each width's own place.
import type { UI } from '@client/kernel.ts'

type Ui = Pick<UI, 'phone' | 'pane' | 'task' | 'term' | 'tterm' | 'termTask'>

/** what the UI becomes once `phone` has flipped (the kernel's own fold already moved a maximized task to the pane);
 *  `before`: the pane the terminal took on the way in, given back on the way out */
export function acrossFold(ui: Ui, before: UI['pane'] = null): Partial<UI> {
  if (ui.phone) {
    if (ui.pane === 'terminal') return { term: false, tterm: false }
    // the task's terminal when its task is the one on screen, else the space's
    if (ui.tterm && ui.pane === 'tasks' && ui.task) return { pane: 'terminal', termTask: true, term: false, tterm: false }
    if (ui.term) return { pane: 'terminal', termTask: false, term: false, tterm: false }
    return {}
  }
  if (ui.pane !== 'terminal') return {}
  return ui.termTask && ui.task ? { pane: 'tasks', tterm: true, termTask: false } : { pane: before === 'terminal' ? null : before, term: true, termTask: false }
}
