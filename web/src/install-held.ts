// fork: SHEP-34. The top bar's words when the install on the machine that serves the web app isn't whole.
import type { InstallHeld } from '@shared/types.ts'

/** "Shepherdr's install on nextgate isn't whole since Nov 9: <first problem>. The sync to other machines is held." */
export function installHeldLine(install: InstallHeld, machine: string, now = Date.now()): string {
  const since = install.since ? new Date(install.since) : null
  const when = !since ? '' : now - install.since < 20 * 3600_000
    ? ` since ${since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : ` since ${since.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
  const first = (install.problems[0] ?? '').replace(/[.:]\s*$/, '')
  const more = install.problems.length > 1 ? ` (and ${install.problems.length - 1} more)` : ''
  return `Shepherdr's install on ${machine || 'this machine'} isn't whole${when}: ${first}${more}.` +
    (install.held ? ' The sync to other machines is held until it is.' : '')
}
