// fork: Ready card below new messages. A task's Ready for review card waits for the person, their next step, so while
// it waits it sits after the agent's newest word, not where the task first said ready: answering a question in the
// task's chat and the agent's reply after it no longer leave the card above them. Once the task is done the card is
// history and keeps the time it came up. In a space's chat only that task's own rows (its update cards, its news, its
// questions) move it; the Assistant's messages don't, so a card there never hops down on every reply.
import type { Message, Task } from '@shared/types.ts'
import { taskChat } from '@shared/view.ts'

/** a row of the agent's own words or work: not yours, not one still on its way, not a card that waits itself */
const agents = (m: Message) => m.who !== 'you' && !m.waiting && !m.question && !m.secret && !m.newSession

/** a row in a space's chat that is this task's own */
const its = (m: Message, t: Task) => m.card?.task === t.id || m.news?.task === t.id || (!!m.question?.by && m.question.by.chat === taskChat(t))

/** where a review card goes: `at` (when it came up), or just after the newest later row that belongs before it */
export function reviewAt(t: Task, at: number | undefined, messages: Message[] | undefined, inTask: boolean, past: boolean): number | undefined {
  if (past || at === undefined || !messages?.length) return at
  let last = at
  for (const m of messages) if (m.at && m.at >= last && (inTask ? agents(m) : its(m, t))) last = m.at + 1
  return last
}
