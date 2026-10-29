// Fork (dmasiero/shepherdr): tea, Gitea's command line. Its logins (tea login list, remembered for a while) and one
// call of Gitea's API through one of them (tea api), with the HTTP status Gitea answered. Gitea's pull requests
// (gitea.ts) go through here, as GitHub's go through gh (git.ts). FORK.md, docs/gitea.md.
import { sh } from './git.ts'

/** one of tea's logins: its name, its server's address, and the host its SSH remotes use */
export interface TeaLogin {
  name: string
  url: string
  sshHost: string
}

export const TEA_MISSING = 'tea, Gitea\'s command line, is not installed here (or not on the PATH): install it and log in (tea login add)'
export const noLogin = (host: string) => `tea is not logged in to ${host} (tea login list has no login for it): tea login add --url https://${host}`

/** tea, never a prompt; not installed: exit 127, as a shell says it */
const tea = (args: string[], cwd: string, timeoutMs = 60_000) =>
  sh(['tea', ...args], cwd, { timeoutMs, env: { NO_COLOR: '1' } }).catch(() => ({ ok: false, code: 127, out: '', err: TEA_MISSING }))

/** the host of a login's address (https://gitea.example.org:3000/ → gitea.example.org) */
const hostOf = (url: string) => url.replace(/^[a-z+]+:\/\//i, '').split(/[/:]/)[0].toLowerCase()

/** the login serves this host: by its address, or by its SSH host */
export const serves = (l: TeaLogin, host: string) => [hostOf(l.url), l.sshHost.toLowerCase()].includes(host.toLowerCase())

let kept: { at: number; logins: Promise<TeaLogin[] | { error: string }> } | undefined
const KEEP_MS = 60_000

/** tea's logins, asked again after a minute; why not, when tea can't be asked (not installed) */
export function teaLogins(cwd: string): Promise<TeaLogin[] | { error: string }> {
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.logins
  const logins = tea(['login', 'list', '--output', 'json'], cwd, 20_000).then((r) => {
    if (r.code === 127) return { error: TEA_MISSING }
    if (!r.ok) return { error: `tea login list failed: ${(r.err || r.out || 'no output').split('\n')[0]}` }
    try {
      // no login at all: tea prints no list
      const list = JSON.parse(r.out.trim() || '[]') as { name?: string; url?: string; ssh_host?: string }[]
      return list.filter((l) => l.name).map((l) => ({ name: l.name!, url: l.url ?? '', sshHost: l.ssh_host ?? '' }))
    } catch {
      return []
    }
  })
  kept = { at: Date.now(), logins }
  return logins
}

/** tea's logins are asked afresh next time (a test's fake tea changed them) */
export const forgetTeaLogins = () => void (kept = undefined)

/** what Gitea's API answered: its HTTP status, and its body (JSON when it was, else its text; null when empty) */
export interface Answer {
  code: number
  body: unknown
  text: string
}

export const okAnswer = (a: Answer) => a.code >= 200 && a.code < 300

/** one call of Gitea's API as a tea login: `path` without /api/v1/. Null and why: tea could not ask at all. */
export async function api(login: string, cwd: string, method: string, path: string, body?: unknown, timeoutMs?: number): Promise<Answer | { error: string }> {
  const r = await tea(['api', '--login', login, '-i', ...(method === 'GET' ? [] : ['-X', method]), ...(body === undefined ? [] : ['-d', JSON.stringify(body)]), path], cwd, timeoutMs)
  // -i writes the status line to stderr (HTTP/1.1 404 Not Found); tea itself exits 0 whatever it was
  const code = Number(r.err.match(/HTTP\/[\d.]+ (\d{3})/)?.[1] ?? (r.ok ? 200 : 0))
  if (!code) return { error: r.code === 127 ? TEA_MISSING : (r.err || r.out || `tea exited ${r.code}`).split('\n').find((l) => l.trim())! }
  let parsed: unknown = null
  if (r.out.trim()) {
    try {
      parsed = JSON.parse(r.out)
    } catch {
      parsed = r.out
    }
  }
  return { code, body: parsed, text: r.out }
}

/** Gitea's own words for an answer that was no success (never its status's reason phrase: "Conflict" is no conflict) */
export function said(a: Answer | { error: string }) {
  if ('error' in a) return a.error
  const b = a.body as { message?: string } | string | null
  const m = typeof b === 'string' ? b.trim().split('\n')[0] : (b?.message ?? '')
  return `Gitea answered HTTP ${a.code}${m ? `: ${m}` : ''}${a.code === 401 ? ' (tea\'s token for it was refused: tea login add again)' : ''}`
}
