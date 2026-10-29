// Fork (dmasiero/shepherdr): a task's pull request on Gitea, through tea (a stand-in, fake-tea.ts), as
// engine-merge.test.ts has it on GitHub: which repos are on Gitea, a draft opened and readied, checks (commit
// statuses) waited for and sent back, the squash merge at the commit here, news on it, main going red, the task
// panel's pull request, and a follow-up pull request for work after a merge.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sh, repo, world, until, started, Settings } from './engine-world.ts'
import type { FakeGitea } from './fake-tea.ts'

const F = await import('../server/live/engine/forge.ts')
const { forgetTeaLogins } = await import('../server/live/engine/tea.ts')
const { pullRequest } = await import('../server/live/worktree.ts')

setDefaultTimeout(60_000)

const teaBin = mkdtempSync(join(tmpdir(), 'shep-teabin-'))
writeFileSync(join(teaBin, 'tea'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-tea.ts')}" "$@"\n`, { mode: 0o755 })
process.env.PATH = `${teaBin}:${process.env.PATH}`

const REMOTE = 'ssh://git@gitea.test:2222/acme/app.git'

/** a Gitea stand-in: a bare repo is the server, tea is test/fake-tea.ts; the clone's origin reads as Gitea's (SSH) */
function onGitea(o: Partial<FakeGitea> & { remote?: string } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'shep-gitea-origin-'))
  sh('git init -q --bare -b main', bare)
  sh(`git push -q ${bare} main`, repo())
  const dir = mkdtempSync(join(tmpdir(), 'shep-gitea-clone-'))
  const remote = o.remote ?? REMOTE
  sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
  const file = join(mkdtempSync(join(tmpdir(), 'shep-gitea-state-')), 'gitea.json')
  const { remote: _, ...rest } = o
  writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', url: 'https://gitea.test', prs: [], calls: [], ...rest }))
  process.env.FAKE_TEA_STATE = file
  forgetTeaLogins()
  const gt = () => JSON.parse(readFileSync(file, 'utf8')) as FakeGitea
  const set = (patch: Partial<FakeGitea>) => writeFileSync(file, JSON.stringify({ ...gt(), ...patch }))
  return { bare, dir, gt, set }
}

const waitForChecks = (w: ReturnType<typeof world>) => w.settings.set('brief.merge', 'after GitHub checks')
afterEach(() => void new Settings().set('brief.merge', null))

/** a task in a Gitea repo with one commit of work */
async function withWork(w: ReturnType<typeof world>, dir: string, name: string, file = 'hello.txt') {
  const s = await started(w, dir, name)
  writeFileSync(join(s.t.worktree!, file), `${file}\n`)
  sh(`git add -A && git commit -qm "add ${file}"`, s.t.worktree!)
  return s
}

describe('which forge a repo is on', () => {
  test('a remote on a host a tea login serves is Gitea, by its SSH host or its address; any other host is none', async () => {
    const g = onGitea()
    expect(await F.github(g.dir)).toEqual({ host: 'gitea.test', repo: 'acme/app', login: 'test', url: 'https://gitea.test' })
    sh('git remote set-url origin https://gitea.test/acme/app.git', g.dir)
    expect(await F.github(g.dir)).toMatchObject({ host: 'gitea.test', repo: 'acme/app', login: 'test' })
    sh('git remote set-url origin git@elsewhere.test:acme/app.git', g.dir)
    expect(await F.github(g.dir)).toBeNull()
    // GitHub stays GitHub, without asking tea
    sh('git remote set-url origin https://github.com/acme/app.git', g.dir)
    const calls = g.gt().calls.length
    expect(await F.github(g.dir)).toEqual({ host: 'github.com', repo: 'acme/app' })
    expect(g.gt().calls.length).toBe(calls)
  })

  test('shepherdr.forge says it outright: github whatever the host, gitea even with no login (then nothing merges)', async () => {
    const w = world()
    const g = onGitea({ logins: [] })
    expect(await F.github(g.dir)).toBeNull()
    sh('git config shepherdr.forge gitea', g.dir)
    expect(await F.github(g.dir)).toMatchObject({ host: 'gitea.test', repo: 'acme/app', login: '', why: expect.stringContaining('tea is not logged in to gitea.test') })
    const { t } = await withWork(w, g.dir, 'gtforced')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.ok).toBe(false)
    expect(m.error).toContain("tea can't reach Gitea now (gitea.test: tea is not logged in to gitea.test")
    expect(m.error).toContain('tea login list')
    expect(m.error).not.toContain('GitHub')
    expect(sh('git log --format=%s -n 1 main', g.bare)).toBe('init')
    sh('git config shepherdr.forge github', g.dir)
    expect(await F.github(g.dir)).toBeNull()
  })

  test("a login whose token Gitea refuses: nothing merges, here or there", async () => {
    const w = world()
    const g = onGitea({ refused: true })
    const { t } = await withWork(w, g.dir, 'gtrefused')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.error).toContain('Gitea answered HTTP 401')
    expect(sh('git log --format=%s -n 1 main', g.dir)).toBe('init')
    expect(g.gt().prs).toEqual([])
  })
})

describe('on Gitea: a pull request per task', () => {
  test('shepherdr pr opens a WIP draft; done readies it with the summary; merge squash-merges it on Gitea at the commit here', async () => {
    const w = world()
    const g = onGitea()
    const { t, key } = await withWork(w, g.dir, 'gt')
    const r = await w.engine.openPr(t.id)
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Opened PR #1 as a draft')
    expect(r.text).toContain('https://gitea.test/acme/app/pulls/1')
    expect(r.text).not.toContain('GitHub')
    expect(t.pr).toEqual({ number: 1, url: 'https://gitea.test/acme/app/pulls/1' })
    // what shepherdr task show --json prints, for whatever reads it
    expect(w.engine.view(t).pr).toEqual(t.pr)
    expect(g.gt().prs[0]).toMatchObject({ head: t.branch, base: 'main', title: 'WIP: Say hello', state: 'open' })
    expect(g.gt().prs[0].body).toContain('> Add hello.txt. Merge when done.')
    expect(sh(`git rev-parse refs/heads/${t.branch}`, g.bare)).toBe(sh('git rev-parse HEAD', t.worktree!))
    // the task panel's pull request comes from Gitea too
    expect(await pullRequest(t.worktree!, t.branch!)).toEqual({ pr: { number: 1, title: 'Say hello', state: 'draft', url: 'https://gitea.test/acme/app/pulls/1', checks: [] } })
    expect((await w.engine.checks(t.id, 0)).text).toBe('PR #1 has no checks on Gitea: nothing to wait for.')
    await w.engine.done(t.id, 'Added hello.txt.')
    await until(() => g.gt().prs[0].title === 'Say hello')
    expect(g.gt().prs[0].body.startsWith('Added hello.txt.')).toBe(true)
    const m = await w.engine.merge(t.id, { self: true })
    expect(m).toEqual({ ok: true, note: 'merged PR #1 on Gitea, not waiting for its checks' })
    const merge = g.gt().calls.find((c) => c.path === 'repos/acme/app/pulls/1/merge')!
    expect(merge.body).toEqual({ Do: 'squash', MergeTitleField: `${t.id}: Say hello (#1)`, MergeMessageField: 'Added hello.txt.', head_commit_id: sh('git rev-parse HEAD', t.worktree!) })
    expect(g.gt().prs[0]).toMatchObject({ state: 'closed', merged: true })
    expect(sh('git log --format=%s -n 2 main', g.bare).split('\n')).toEqual([`${t.id}: Say hello (#1)`, 'init'])
    // its branch on Gitea is gone, and main here is Gitea's
    expect(sh(`git branch --list ${t.branch}`, g.bare)).toBe('')
    expect(sh('git rev-parse main', g.dir)).toBe(sh('git rev-parse main', g.bare))
    expect(existsSync(join(g.dir, 'hello.txt'))).toBe(true)
    expect(w.engine.statusOf(t)).toBe('done')
    // every call went through the repo's login
    expect(g.gt().calls.filter((c) => c.method).every((c) => c.args.includes('--login') && c.args.includes('test'))).toBe(true)
    w.agentIs(key, 'idle')
    await until(() => !!t.cleaned)
    expect(existsSync(t.worktree!)).toBe(false)
  })

  test('merge opens the pull request itself when the agent never did', async () => {
    const w = world()
    const g = onGitea({ remote: 'https://gitea.test/acme/app.git' })
    const { t } = await withWork(w, g.dir, 'gtmerge', 'mine.txt')
    w.agentIs(`${t.id}/Agent`, 'idle')
    expect(await w.engine.merge(t.id)).toEqual({ ok: true, note: 'merged PR #1 on Gitea, not waiting for its checks' })
    expect(g.gt().prs[0]).toMatchObject({ number: 1, title: 'Say hello', merged: true })
    expect(sh('git show --name-only --format= main', g.dir)).toBe('mine.txt')
  })

  test("failed statuses go back to the agent in Gitea's words; merging waits while they run and for those main requires", async () => {
    const w = world()
    const g = onGitea({ statuses: [{ context: 'ci / test (pull_request)', status: 'failure', target_url: '/acme/app/actions/runs/7/jobs/9' }, { context: 'ci / lint (pull_request)', status: 'success' }] })
    waitForChecks(w)
    const { t, key } = await withWork(w, g.dir, 'gtfail', 'x.txt')
    await w.engine.openPr(t.id)
    const c = await w.engine.checks(t.id, 0)
    expect(c.ok).toBe(false)
    expect(c.text).toContain("Gitea's checks failed on PR #1: ci / test (pull_request). See https://gitea.test/acme/app/actions/runs/7/jobs/9.")
    expect(c.text).not.toMatch(/GitHub|gh run/)
    expect((await pullRequest(t.worktree!, t.branch!)).pr!.checks).toEqual([
      { name: 'ci / test (pull_request)', state: 'fail', url: 'https://gitea.test/acme/app/actions/runs/7/jobs/9' },
      { name: 'ci / lint (pull_request)', state: 'pass', url: undefined },
    ])
    await w.engine.done(t.id, 'x')
    w.agentIs(key, 'idle')
    const m = await w.engine.merge(t.id)
    expect(m.error).toContain('Sent back')
    expect(w.sent.at(-1)!.key).toBe(key)
    expect(w.sent.at(-1)!.text).toContain("Gitea's checks failed on PR #1")
    expect(w.sent.at(-1)!.text).not.toContain('GitHub')
    expect(g.gt().prs[0].state).toBe('open')
    // still running
    g.set({ statuses: [{ context: 'ci / test (pull_request)', status: 'pending' }] })
    expect((await w.engine.merge(t.id, { self: true })).error).toContain(`Gitea's checks are running on PR #1`)
    // passed, but main's protection requires one that has not shown yet
    g.set({ statuses: [{ context: 'ci / test (pull_request)', status: 'success' }], protections: [{ rule_name: 'main', enable_status_check: true, status_check_contexts: ['ci / test (pull_request)', 'deploy / preview'] }] })
    expect((await w.engine.checks(t.id, 0)).text).toContain('still run')
    g.set({ statuses: [{ context: 'ci / test (pull_request)', status: 'success' }, { context: 'deploy / preview', status: 'warning' }] })
    expect((await w.engine.checks(t.id, 0)).text).toBe("Gitea's checks passed on PR #1 (2).")
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
  })

  test("a conflict Gitea refuses (it only says to try later) is said as one; a head that moved is refused", async () => {
    const w = world()
    const g = onGitea()
    const { t } = await started(w, g.dir, 'gtclash')
    writeFileSync(join(t.worktree!, 'README.md'), 'mine\n')
    sh('git commit -qam mine', t.worktree!)
    await w.engine.openPr(t.id)
    const head = sh('git rev-parse HEAD', t.worktree!)
    const other = mkdtempSync(join(tmpdir(), 'shep-gitea-other-'))
    sh(`git clone -q ${g.bare} . && git config user.email t@t && git config user.name T && echo theirs > README.md && git commit -qam theirs && git push -q origin main`, other)
    const GT = await import('../server/live/engine/gitea.ts')
    const at = { host: 'gitea.test', repo: 'acme/app', login: 'test' }
    await GT.readyPr(at, g.dir, 1)
    expect((await GT.mergePr(at, g.dir, 1, 'f'.repeat(40), 's', 'b')).err).toBe('Gitea answered HTTP 409: head out of date')
    expect((await GT.mergePr(at, g.dir, 1, head, 's', 'b')).err).toBe('PR #1 is not mergeable: it conflicts with main (Gitea answered HTTP 405: Please try again later)')
    // shepherdr merge sees it before Gitea does, and hands the rebase to the agent
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.error).toContain('Conflict with main: rebase')
    expect(g.gt().prs[0].state).toBe('open')
  })

  test("news on a done task's pull request wakes its agent once, in Gitea's words: a failed status with its log's end, reviews and comments", async () => {
    const w = world()
    const g = onGitea({ statuses: [{ context: 'test', status: 'success' }] })
    const { t, key } = await withWork(w, g.dir, 'gtnews', 'x.txt')
    await w.engine.openPr(t.id)
    await w.engine.done(t.id, 'x')
    w.agentIs(key, 'idle')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(0)
    const pulls = 'repos/acme/app/pulls/1'
    g.set({
      statuses: [{ context: 'test', status: 'failure', target_url: '/acme/app/actions/runs/7/jobs/9' }],
      // as Gitea's runner logs a job: what failed, then its clean-up
      logs: { '9': ['ok 1', 'expected 1 to be 2', 'Cleaning up container for job test', '🏁  Job failed'].map((l) => `2026-10-26T10:00:00.1234567Z ${l}`).join('\n') },
      api: {
        [`${pulls}/reviews`]: [
          { id: 1, user: { login: 'ann' }, body: 'Please rename it.', state: 'REQUEST_CHANGES', html_url: 'https://gitea.test/acme/app/pulls/1#r1', submitted_at: '2099-01-01T00:00:00Z', comments_count: 0 },
          { id: 2, user: { login: 'bob' }, body: '', state: 'COMMENT', html_url: 'https://gitea.test/acme/app/pulls/1#r2', submitted_at: '2099-01-01T00:00:01Z', comments_count: 1 },
          { id: 3, user: { login: 'cy' }, body: 'draft', state: 'PENDING', submitted_at: '2099-01-01T00:00:02Z', comments_count: 0 },
        ],
        [`${pulls}/reviews/2/comments`]: [{ id: 5, user: { login: 'bob' }, body: 'Typo here.', path: 'x.txt', position: 1, html_url: 'https://gitea.test/acme/app/pulls/1/files#c5', created_at: '2000-01-01T00:00:00Z' }],
        ['repos/acme/app/issues/1/comments']: [{ id: 4, user: { login: 'cy' }, body: 'Old news.', html_url: 'https://gitea.test/acme/app/pulls/1#i4', created_at: '2000-01-01T00:00:00Z' }],
      },
    })
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
    const told = w.sent[0].text
    expect(told).toContain('Gitea news on PR #1 (https://gitea.test/acme/app/pulls/1)')
    expect(told).toContain('- Check failed: test (https://gitea.test/acme/app/actions/runs/7/jobs/9). Its log ends:\n    ok 1\n    expected 1 to be 2\n- ')
    expect(told).not.toContain('Cleaning up')
    expect(told).toContain('- Changes requested by ann (https://gitea.test/acme/app/pulls/1#r1):\n    Please rename it.')
    expect(told).toContain('- Comment by bob on x.txt:1 (https://gitea.test/acme/app/pulls/1/files#c5):\n    Typo here.')
    expect(told).not.toMatch(/Old news|draft|GitHub/)
    await w.engine.done(t.id, 'x')
    await w.engine.watchPrs()
    expect(w.sent.length).toBe(1)
  })

  test("main going red on Gitea after a merge tells its coordinator once, with the run and its log", async () => {
    const w = world()
    const g = onGitea()
    const { t } = await withWork(w, g.dir, 'gtred', 'x.txt')
    for (const x of w.engine.tasks) x.doneAt = 0
    expect((await w.engine.merge(t.id, { self: true })).ok).toBe(true)
    const red = sh('git rev-parse main', g.bare)
    const green = sh('git rev-parse main~1', g.bare)
    const run = (head_sha: string, conclusion: string, id: number) => ({ id, head_sha, status: 'completed', conclusion, event: 'push', head_branch: 'main', path: 'check.yml@refs/heads/main', html_url: `https://gitea.test/acme/app/actions/runs/${id}` })
    g.set({ runs: [run(red, 'failure', 3), run(green, 'success', 2)], api: { 'repos/acme/app/actions/runs/3/jobs': { jobs: [{ id: 9, conclusion: 'failure' }] } }, logs: { '9': 'expected 1 to be 2\nCleaning up container for job test' } })
    const before = w.news.length
    await w.engine.watchMains()
    expect(w.news.length).toBe(before + 1)
    const told = w.news.at(-1)!
    expect(told).toContain(`main went red on Gitea at ${red.slice(0, 7)}: check.yml failed (https://gitea.test/acme/app/actions/runs/3).`)
    expect(told).toContain(`Merged since it was last green (${green.slice(0, 7)}): ${t.id}: Say hello (#1).`)
    expect(told).toContain('    expected 1 to be 2')
    await w.engine.watchMains()
    expect(w.news.length).toBe(before + 1)
  })
})

describe('a pull request merged already', () => {
  test('merged by hand with nothing since: main here catches up and it is marked merged, even with its branch gone', async () => {
    const w = world()
    const g = onGitea()
    const { t } = await withWork(w, g.dir, 'gthand', 'y.txt')
    await w.engine.openPr(t.id)
    const F2 = await import('../server/live/engine/gitea.ts')
    const at = { host: 'gitea.test', repo: 'acme/app', login: 'test' }
    await F2.readyPr(at, g.dir, 1)
    expect((await F2.mergePr(at, g.dir, 1, '', 'by hand', '')).ok).toBe(true)
    // Gitea names a merged pull request's head by itself once its branch is gone
    sh(`git push -q origin --delete ${t.branch}`, g.dir)
    expect(await F2.findPr(at, g.dir, t.branch!)).toMatchObject({ number: 1, state: 'MERGED' })
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'PR #1 was merged on Gitea already' })
    expect(existsSync(join(g.dir, 'y.txt'))).toBe(true)
    expect(g.gt().prs.length).toBe(1)
  })

  test('work on its branch since the merge goes in a follow-up pull request, which becomes the task\'s own', async () => {
    const w = world()
    const g = onGitea()
    const { t, key } = await withWork(w, g.dir, 'gtfollow', 'first.txt')
    await w.engine.openPr(t.id)
    await w.engine.done(t.id, 'First part.')
    await until(() => g.gt().prs[0].title === 'Say hello')
    const at = { host: 'gitea.test', repo: 'acme/app', login: 'test' }
    expect((await (await import('../server/live/engine/gitea.ts')).mergePr(at, g.dir, 1, '', 'by hand', '')).ok).toBe(true)
    // the agent went on after it was merged, and left its last change uncommitted
    writeFileSync(join(t.worktree!, 'second.txt'), 'second\n')
    w.agentIs(key, 'idle')
    const m = await w.engine.merge(t.id)
    expect(m.ok).toBe(false)
    expect(m.error).toContain(`PR #1 was merged on Gitea already, and ${t.branch} has work since that it did not bring in: opened follow-up PR #2 (https://gitea.test/acme/app/pulls/2)`)
    expect(w.sent.at(-1)!.text).toContain('opened follow-up PR #2')
    expect(t.pr).toEqual({ number: 2, url: 'https://gitea.test/acme/app/pulls/2' })
    expect(g.gt().prs[1]).toMatchObject({ head: t.branch, base: 'main', title: 'Say hello (follow-up)', state: 'open' })
    expect(g.gt().prs[1].body).toContain('Follow-up to #1 (https://gitea.test/acme/app/pulls/1)')
    expect(t.merged).toBeFalsy()
    // its agent merges the follow-up
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #2 on Gitea, not waiting for its checks' })
    expect(existsSync(join(g.dir, 'first.txt')) && existsSync(join(g.dir, 'second.txt'))).toBe(true)
    expect(sh('git log --format=%s -n 3 main', g.bare).split('\n')).toEqual([`${t.id}: Say hello (#2)`, 'by hand', 'init'])
  })

  test('shepherdr pr on a merged pull request with work since opens the follow-up, a draft until done', async () => {
    const w = world()
    const g = onGitea()
    const { t } = await withWork(w, g.dir, 'gtfollowpr', 'first.txt')
    await w.engine.openPr(t.id)
    const at = { host: 'gitea.test', repo: 'acme/app', login: 'test' }
    const G2 = await import('../server/live/engine/gitea.ts')
    await G2.readyPr(at, g.dir, 1)
    expect((await G2.mergePr(at, g.dir, 1, '', 'by hand', '')).ok).toBe(true)
    expect((await w.engine.openPr(t.id)).text).toContain('is merged on Gitea already: run shepherdr merge')
    writeFileSync(join(t.worktree!, 'second.txt'), 'second\n')
    sh('git add -A && git commit -qm second', t.worktree!)
    const r = await w.engine.openPr(t.id)
    expect(r).toEqual({ ok: true, text: `PR #1 was merged on Gitea already, and ${t.branch} has work since that it did not bring in: opened follow-up PR #2 as a draft: https://gitea.test/acme/app/pulls/2` })
    expect(g.gt().prs[1].title).toBe('WIP: Say hello (follow-up)')
  })
})

describe('a follow-up on GitHub', () => {
  test('the same through gh: work since a hand merge opens a follow-up pull request there', async () => {
    const ghBin = mkdtempSync(join(tmpdir(), 'shep-ghbin-'))
    writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, 'fake-gh.ts')}" "$@"\n`, { mode: 0o755 })
    process.env.PATH = `${ghBin}:${process.env.PATH}`
    const bare = mkdtempSync(join(tmpdir(), 'shep-gh-origin-'))
    sh('git init -q --bare -b main', bare)
    sh(`git push -q ${bare} main`, repo())
    const dir = mkdtempSync(join(tmpdir(), 'shep-gh-clone-'))
    const remote = 'https://github.com/acme/app.git'
    sh(`git clone -q ${bare} . && git config user.email t@t && git config user.name T && git remote set-url origin ${remote} && git config url.${bare}.insteadOf ${remote}`, dir)
    const file = join(mkdtempSync(join(tmpdir(), 'shep-gh-state-')), 'github.json')
    writeFileSync(file, JSON.stringify({ origin: bare, repo: 'acme/app', prs: [], calls: [] }))
    process.env.FAKE_GH_STATE = file
    const gh = () => JSON.parse(readFileSync(file, 'utf8')) as { prs: { title: string; body: string; state: string; isDraft: boolean }[] }
    const w = world()
    const { t } = await withWork(w, dir, 'ghfollow', 'first.txt')
    await w.engine.openPr(t.id)
    writeFileSync(file, JSON.stringify({ ...gh(), prs: gh().prs.map((p) => ({ ...p, isDraft: false })) }))
    sh(`"${join(ghBin, 'gh')}" pr merge 1 --squash`, dir)
    writeFileSync(join(t.worktree!, 'second.txt'), 'second\n')
    const m = await w.engine.merge(t.id, { self: true })
    expect(m.error).toContain('PR #1 was merged on GitHub already')
    expect(m.error).toContain('opened follow-up PR #2 (https://github.com/acme/app/pull/2)')
    expect(gh().prs[1]).toMatchObject({ title: 'Say hello (follow-up)', state: 'OPEN' })
    expect(await w.engine.merge(t.id, { self: true })).toEqual({ ok: true, note: 'merged PR #2 on GitHub, not waiting for its checks' })
    expect(existsSync(join(dir, 'second.txt'))).toBe(true)
  })
})
