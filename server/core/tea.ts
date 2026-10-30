// Fork (dmasiero/shepherdr): tea, Gitea's command line, as gh is GitHub's. Its logins (tea login list) and one call of
// Gitea's API through one of them (tea api -i), with the HTTP status Gitea answered. Gitea's pull requests (gitea.ts)
// go through here. FORK.md, docs/gitea.md.

/** one of tea's logins: its name, its server's address, and the host its SSH remotes use */
export interface TeaLogin { name: string; url: string; sshHost: string }

export const TEA_MISSING = 'tea, Gitea’s command line, is not installed here (or not on the PATH): install it and log in (tea login add)'
export const noLogin = (host: string) => `tea is not logged in to ${host} (tea login list has no login for it): tea login add --url https://${host}`

/** tea with its status lines and its answer read together: `tea api -i` writes Gitea's HTTP status to stderr. Both
 *  streams go to stdout when tea succeeds; when it fails, to stderr, so the command's error says why. */
export function teaArgv(args: string[]) {
  return ['sh', '-c', 'out=$(NO_COLOR=1 tea "$@" 2>&1); s=$?; if [ "$s" = 0 ]; then printf "%s" "$out"; else printf "%s\\n" "$out" >&2; fi; exit "$s"', 'tea', ...args]
}

/** tea could not run at all: not installed is said plainly */
export function teaFailure(error: unknown) {
  const text = String((error as Error)?.message ?? error)
  return /tea: (?:command )?not found|exited with 127|Install tea for checked repository commands/i.test(text) ? TEA_MISSING : `tea failed: ${text.split('\n').find(line => line.trim())?.slice(0, 500) ?? 'no output'}`
}

/** the host of a login's address (https://gitea.example.org:3000/ → gitea.example.org) */
export const hostOf = (url: string) => url.replace(/^[a-z+]+:\/\//i, '').split(/[/:@]/)[0].toLowerCase()

/** the login serves this host: by its address, or by its SSH host */
export const serves = (login: TeaLogin, host: string) => [hostOf(login.url), login.sshHost.toLowerCase()].includes(host.toLowerCase())

/** tea login list --output json; no login at all prints no list */
export function parseLogins(text: string): TeaLogin[] {
  const list = JSON.parse(text.trim() || '[]') as { name?: unknown; url?: unknown; ssh_host?: unknown }[]
  if (!Array.isArray(list)) throw Error('tea login list did not return a list')
  return list.filter(login => typeof login?.name === 'string' && login.name)
    .map(login => ({ name: String(login.name), url: typeof login.url === 'string' ? login.url : '', sshHost: typeof login.ssh_host === 'string' ? login.ssh_host : '' }))
}

/** what Gitea's API answered: its HTTP status, and its body (JSON when it was, else its text; null when empty) */
export interface Answer { code: number; body: unknown; text: string }

export const okAnswer = (answer: Answer) => answer.code >= 200 && answer.code < 300

/** tea api -i's output: the status line and headers, a blank line, then the body */
export function parseAnswer(out: string): Answer {
  const status = out.match(/^HTTP\/[\d.]+ (\d{3})(?:[^\n]*)(?:\n|$)/)
  if (!status) throw Error(`tea did not report Gitea’s answer: ${out.split('\n').find(line => line.trim())?.slice(0, 300) ?? 'no output'}`)
  const end = out.search(/\r?\n\r?\n/)
  const text = end < 0 ? '' : out.slice(end).replace(/^\r?\n\r?\n/, '')
  let body: unknown = null
  if (text.trim()) { try { body = JSON.parse(text) } catch { body = text } }
  return { code: Number(status[1]), body, text }
}

/** Gitea's own words for an answer that was no success (never its status's reason phrase: "Conflict" is no conflict) */
export function said(answer: Answer) {
  const body = answer.body as { message?: unknown } | string | null
  const message = typeof body === 'string' ? body.trim().split('\n')[0] : typeof body?.message === 'string' ? body.message : ''
  return `Gitea answered HTTP ${answer.code}${message ? `: ${message.slice(0, 500)}` : ''}${answer.code === 401 ? ' (tea’s token for it was refused: tea login add again)' : ''}`
}
