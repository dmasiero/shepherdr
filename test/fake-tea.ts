// Fork (dmasiero/shepherdr): a stand-in for tea in tests, as fake-gh.ts is for gh. Gitea is a bare repo on disk
// (FAKE_TEA_STATE's "origin"), its pull requests and statuses live in that JSON file, and every call is written down
// there. Only what Shepherdr asks of tea is here: login list, and api as one login (-i: the HTTP status line to
// stderr; -d @-: the body on stdin) on the paths server/core/gitea.ts reads and writes. Any other path answers from
// "api" by its path, or 404.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeGiteaPr {
  number: number
  head: string
  base: string
  title: string
  body: string
  state: 'open' | 'closed'
  merged?: boolean
  /** the head it was at when it closed or merged */
  at?: string
  mergeCommit?: string
}

export interface FakeGitea {
  origin: string
  /** owner/name */
  repo: string
  /** the server's address: https://gitea.test */
  url: string
  /** tea login list; none given: one login, "test", for the server */
  logins?: { name: string; url: string; ssh_host: string }[]
  /** the login's token is refused (GET user answers 401) */
  refused?: boolean
  /** Gitea deletes a pull request's branch once it merges it */
  deleteBranches?: boolean
  /** pull requests from a fork of the repo (repo_id 2), by number */
  forked?: number[]
  prs: FakeGiteaPr[]
  /** the commit statuses on any pull request's head, as Gitea lists them */
  statuses?: { context: string; status: string; target_url?: string }[]
  /** the combined state Gitea reports, when it is to differ from what the statuses make */
  combined?: string
  /** GET repos/…/branch_protections */
  protections?: unknown[]
  /** Gitea Actions' runs, newest first (workflow_runs) */
  runs?: unknown[]
  /** a job's log by job id */
  logs?: Record<string, string>
  /** what any other GET answers, by its path without its query */
  api?: Record<string, unknown>
  calls: { args: string[]; method: string; path: string; body?: unknown }[]
}

const wip = (t: string) => /^\s*(wip:|\[wip\])/i.test(t)

/** a folder with a `tea` that is this fake, for a PATH, and the state file it reads */
export function fakeTea(root: string, state: FakeGitea) {
  const bin = join(root, 'fake-tea-bin'), file = join(root, 'fake-tea.json')
  execFileSync('mkdir', ['-p', bin])
  writeFileSync(join(bin, 'tea'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, 'fake-tea.ts'))} "$@"\n`)
  chmodSync(join(bin, 'tea'), 0o755)
  writeFileSync(file, JSON.stringify(state))
  return { bin, file, read: () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitea, write: (next: FakeGitea) => writeFileSync(file, JSON.stringify(next)) }
}

if (import.meta.main) {
  const file = process.env.FAKE_TEA_STATE!
  const lock = `${file}.lock`
  for (let tries = 0; ; tries++) {
    try {
      openSync(lock, 'wx')
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 3000) throw e
      Bun.sleepSync(5)
    }
  }
  process.on('exit', () => unlinkSync(lock))
  const st = JSON.parse(readFileSync(file, 'utf8')) as FakeGitea
  const args = process.argv.slice(2)
  const save = () => {
    writeFileSync(`${file}.tmp`, JSON.stringify(st, null, 2))
    renameSync(`${file}.tmp`, file)
  }
  const host = st.url.replace(/^https?:\/\//, '')
  const logins = st.logins ?? [{ name: 'test', url: st.url, ssh_host: host }]
  if (args[0] === 'login' && args[1] === 'list') {
    st.calls.push({ args, method: '', path: '' })
    save()
    process.stdout.write(`${JSON.stringify(logins.map((l) => ({ ...l, user: 't', default: 'false' })), null, 2)}\n`)
    process.exit(0)
  }
  if (args[0] !== 'api') {
    process.stderr.write(`fake tea: no ${args[0]}\n`)
    process.exit(1)
  }
  const opt = (...names: string[]) => {
    const i = args.findIndex((a) => names.includes(a))
    return i >= 0 ? args[i + 1] : undefined
  }
  const login = opt('--login', '-l')
  if (!logins.some((l) => l.name === login)) {
    process.stderr.write(`Error: login name '${login}' does not exist\n`)
    process.exit(1)
  }
  const data = opt('-d', '--data')
  const body = data ? (JSON.parse(data === '@-' ? readFileSync(0, 'utf8') : data) as Record<string, string>) : undefined
  const method = opt('-X', '--method') ?? (body ? 'POST' : 'GET')
  const full = args.at(-1)!
  const [path, query = ''] = full.split('?')
  const q = new URLSearchParams(query)
  st.calls.push({ args, method, path, body })
  const answer = (code: number, out: unknown): never => {
    save()
    process.stderr.write(`HTTP/1.1 ${code} X\nContent-Type: application/json\n\n`)
    if (out !== undefined) process.stdout.write(typeof out === 'string' ? out : `${JSON.stringify(out)}\n`)
    process.exit(0)
  }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: st.origin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const headOf = (branch: string) => {
    try {
      return git('rev-parse', `refs/heads/${branch}`)
    } catch {
      return ''
    }
  }
  const repo = `repos/${st.repo}`
  // As Gitea 28 does: its list names a closed pull request's head where it closed, and its answer for one pull
  // request names its branch's tip, wherever that went since (refs/pull/<n>/head keeps where it closed).
  const json = (p: FakeGiteaPr, one = false) => {
    const at = p.state === 'open' || one && headOf(p.head) ? headOf(p.head) : p.at
    // a pull request whose branch is gone: Gitea names its head by the pull request, and keeps the branch as its label
    const ref = headOf(p.head) ? p.head : `refs/pull/${p.number}/head`
    // Gitea's mergeable: the branch merges into its base without a conflict
    let mergeable = true
    if (p.state === 'open' && at)
      try {
        git('merge-tree', '--write-tree', `refs/heads/${p.base}`, at)
      } catch {
        mergeable = false
      }
    return { number: p.number, html_url: `${st.url}/${st.repo}/pulls/${p.number}`, state: p.state, merged: !!p.merged, draft: wip(p.title), title: p.title, body: p.body, mergeable, merge_commit_sha: p.mergeCommit ?? null, head: { ref, label: p.head, sha: at, repo_id: st.forked?.includes(p.number) ? 2 : 1 }, base: { ref: p.base, repo_id: 1 } }
  }
  const pr = (n: string) => st.prs.find((p) => p.number === Number(n))
  let m: RegExpMatchArray | null
  if (method === 'GET' && path === 'user') st.refused ? answer(401, { message: 'token is required' }) : answer(200, { login: 't' })
  if (path === `${repo}/pulls` && method === 'GET') {
    const state = q.get('state') ?? 'open'
    const all = st.prs.filter((p) => state === 'all' || p.state === state).reverse()
    const limit = Number(q.get('limit') ?? 30)
    const page = Number(q.get('page') ?? 1)
    answer(200, all.slice((page - 1) * limit, page * limit).map((p) => json(p)))
  }
  if (path === `${repo}/pulls` && method === 'POST') {
    if (!headOf(body!.head)) answer(422, { message: `branch ${body!.head} does not exist` })
    if (st.prs.some((p) => p.state === 'open' && p.head === body!.head && p.base === body!.base && !st.forked?.includes(p.number))) answer(409, { message: 'pull request already exists for these targets' })
    const p: FakeGiteaPr = { number: st.prs.length + 1, head: body!.head, base: body!.base, title: body!.title, body: body!.body ?? '', state: 'open' }
    st.prs.push(p)
    answer(201, json(p))
  }
  if ((m = path.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/))) {
    const p = pr(m[1]) ?? answer(404, { message: 'pull request does not exist' })!
    if (method === 'PATCH') {
      if (body!.body !== undefined) p.body = body!.body
      if (body!.title !== undefined) p.title = body!.title
      if (body!.state === 'closed' && p.state === 'open') Object.assign(p, { state: 'closed', at: headOf(p.head) })
    }
    answer(200, json(p, true))
  }
  if ((m = path.match(/^repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/)) && method === 'POST') {
    const p = pr(m[1]) ?? answer(404, { message: 'pull request does not exist' })!
    if (p.merged) answer(405, { message: 'The PR is already merged' })
    if (p.state !== 'open') answer(405, { message: 'The PR is closed' })
    if (wip(p.title)) answer(405, { message: 'The PR is a work in progress' })
    const at = headOf(p.head)
    if (body!.head_commit_id && body!.head_commit_id !== at) answer(409, { message: 'head out of date' })
    const tmp = mkdtempSync(join(tmpdir(), 'fake-tea-merge-'))
    try {
      const g = (...a: string[]) => execFileSync('git', a, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      g('clone', '-q', '-b', p.base, st.origin, '.')
      g('fetch', '-q', 'origin', p.head)
      try {
        if (body!.Do === 'squash') g('merge', '--squash', 'FETCH_HEAD')
        else g('-c', 'user.email=gitea@t', '-c', 'user.name=Gitea', 'merge', '--no-ff', '--no-commit', 'FETCH_HEAD')
      } catch {
        // Gitea refuses a pull request that conflicts with "try again later", and marks it not mergeable
        rmSync(tmp, { recursive: true, force: true })
        answer(405, { message: 'Please try again later' })
      }
      g('-c', 'user.email=gitea@t', '-c', 'user.name=Gitea', 'commit', '-q', '-m', `${body!.MergeTitleField ?? p.title}\n\n${body!.MergeMessageField ?? ''}`.trim())
      g('push', '-q', 'origin', `HEAD:refs/heads/${p.base}`)
      if (st.deleteBranches) g('push', '-q', 'origin', `:refs/heads/${p.head}`)
      Object.assign(p, { state: 'closed', merged: true, at, mergeCommit: g('rev-parse', 'HEAD').trim() })
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
    answer(200, undefined)
  }
  if ((m = path.match(/^repos\/[^/]+\/[^/]+\/git\/refs\/pull\/(\d+)\/head$/))) {
    const p = pr(m[1]) ?? answer(404, { message: 'reference does not exist' })!
    answer(200, [{ ref: `refs/pull/${p.number}/head`, object: { type: 'commit', sha: p.state === 'open' ? headOf(p.head) : p.at } }])
  }
  if ((m = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/)) && method === 'POST') {
    const list = ((st.api ??= {})[path] ??= []) as unknown[]
    list.push({ id: 1000 + list.length, user: { login: 't' }, body: body!.body, html_url: `${st.url}/${st.repo}/pulls/${m[1]}#c`, created_at: new Date().toISOString() })
    answer(201, list.at(-1))
  }
  if (path.match(/^repos\/[^/]+\/[^/]+\/commits\/[^/]+\/status$/)) {
    // Gitea's combined status, as Gitea 28 makes it: the statuses page by page, and both the state and total_count
    // of that page's own
    const all = st.statuses ?? []
    const limit = Number(q.get('limit') ?? 30)
    const page = Number(q.get('page') ?? 1)
    const statuses = all.slice((page - 1) * limit, page * limit)
    const has = (...x: string[]) => statuses.some((s) => x.includes(s.status))
    const state = (page === 1 ? st.combined : undefined) ?? (has('failure', 'error') ? 'failure' : has('pending') ? 'pending' : statuses.length ? 'success' : '')
    answer(200, { state, total_count: statuses.length, statuses })
  }
  if (path === `${repo}/branch_protections`) answer(200, st.protections ?? [])
  if (path === `${repo}/actions/runs`) {
    const runs = (st.runs ?? []) as { head_branch?: string; event?: string }[]
    answer(200, { workflow_runs: runs.filter((r) => (!q.get('branch') || r.head_branch === q.get('branch')) && (!q.get('event') || r.event === q.get('event'))), total_count: runs.length })
  }
  if ((m = path.match(/\/actions\/jobs\/(\d+)\/logs$/))) st.logs?.[m[1]] !== undefined ? answer(200, st.logs[m[1]]) : answer(404, { message: 'job not found' })
  if (method === 'GET' && st.api?.[path] !== undefined) {
    const v = st.api[path]
    // a list answers page by page, as Gitea's do
    if (Array.isArray(v)) {
      const limit = Number(q.get('limit') ?? 30)
      const page = Number(q.get('page') ?? 1)
      answer(200, v.slice((page - 1) * limit, page * limit))
    }
    answer(200, v)
  }
  // an empty list where Gitea has one and nothing was set
  if (method === 'GET' && /\/(reviews|comments)$/.test(path)) answer(200, [])
  answer(404, { message: `fake tea: no ${method} ${path}` })
}
