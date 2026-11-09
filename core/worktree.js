// A task's worktree as its side views read it: what it changed against its base (Changes) and its pull request
// (Pull request), for the window's task-pr mod and the web app's Changes and Pull request alike. git and
// gh run through a runner the caller gives (the window's exec, the service's herdr-core), on the task's machine.
// Shared core: the source is core/worktree.js; bin/sync-shared copies it into the mods in lib/COPIES.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie): a folder watch would see it, and
// every refresh would start the next one.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

// Where the task left its base: the fork point with its base branch, unless the base already holds all of it
// (merged), then the commit it started from. Neither: its last commit (only what isn't committed shows, as Herdr's
// Changes). git(args) -> { code, stdout }.
export async function against(git, { base, start }) {
  const head = (await git(["rev-parse", "--verify", "HEAD"])).stdout?.trim();
  if (!head) return null;
  if (base) {
    const mb = await git(["merge-base", "HEAD", base]);
    const at = mb.code === 0 ? mb.stdout.trim() : null;
    if (at && at !== head) return { rev: at, label: base };
  }
  if (start && start !== head && (await git(["cat-file", "-e", `${start}^{commit}`])).code === 0) return { rev: start, label: base ?? start.slice(0, 7) };
  return { rev: "HEAD", label: null };
}

// The changed files from `diff --name-status -z`, `diff --numstat -z` and `ls-files --others -z`, by path:
// [{ path, status: "A" | "M" | "D" | "U", fresh (not in git yet), add, del, binary? }].
export function changedFiles(names, nums, fresh) {
  const stats = {};
  for (const entry of String(nums).split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) stats[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  const files = [], parts = String(names).split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const xy = parts[i], path = parts[i + 1];
    const s = xy.startsWith("U") ? "U" : xy.startsWith("D") ? "D" : xy.startsWith("A") ? "A" : "M";
    files.push({ path, status: s, fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  for (const path of String(fresh).split("\0").filter(Boolean)) files.push({ path, status: "A", fresh: true, add: 0, del: 0 });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export const PR_FIELDS = "number,title,state,isDraft,url,headRefName,baseRefName,additions,deletions,changedFiles,statusCheckRollup";

// A check, as Shepherdr sorts them: pass, fail, pending (running or waiting) or skip.
export function checkOf(c) {
  if (c.__typename === "StatusContext") {
    const s = String(c.state ?? "").toUpperCase();
    return { name: c.context ?? "Status", url: c.targetUrl || null,
      state: s === "SUCCESS" ? "pass" : s === "PENDING" || s === "EXPECTED" ? "pending" : "fail" };
  }
  const done = String(c.status ?? "").toUpperCase() === "COMPLETED", end = String(c.conclusion ?? "").toUpperCase();
  return { name: c.name ?? c.workflowName ?? "Check", workflow: c.workflowName || null, url: c.detailsUrl || null,
    state: !done ? "pending" : end === "SUCCESS" ? "pass" : end === "SKIPPED" || end === "NEUTRAL" ? "skip" : "fail" };
}

// "1 failed · 2 running · 3 passed"
export function checksLine(cs) {
  const n = (s) => cs.filter((c) => c.state === s).length;
  return [[n("fail"), "failed"], [n("pending"), "running"], [n("pass"), "passed"], [n("skip"), "skipped"]]
    .filter(([k]) => k).map(([k, w]) => `${k} ${w}`).join(" · ");
}

// Failed first, then running, passed, skipped: what needs a look sits on top.
export const CHECK_ORDER = { fail: 0, pending: 1, pass: 2, skip: 3 };

// The side views' words: the web app's Files and Changes (the space's side panels) and Pull request (a task's tab,
// as the window's mods/task-pr says it: core/worktree.test.js checks it still says its words).
export const VIEW_WORDS = {
  allFiles: "All files",
  loadingFiles: "Loading files…",
  noFiles: "No files",
  noFolder: "No folder for this task",
  folderGone: "This task's folder can't be read. It may have been removed after the task finished.",
  limited: "File list limited to 500 entries per folder and 5,000 total",
  loadingFile: "Loading file…",
  fileGone: "This file is no longer available.",
  binaryFile: "Binary file · No text preview",
  cantPreview: "Can't preview this file. It's binary, too large or unreadable.",
  truncated: "… (file truncated)",
  loadingChanges: "Loading changes…",
  notGit: "This task's folder isn't a git repository.",
  noCommits: "This repository has no commits.",
  uncommitted: "Uncommitted",
  noUncommitted: "No uncommitted changes",
  pickChange: "Select a file to see its changes.",
  cantDiff: "Can't preview this diff. It's too large or unreadable.",
  binaryDiff: "Binary file · No text diff",
  binaryChanged: "Binary file changed",
  noTextDiff: "No text diff available",
  firstThousand: "Showing the first 1,000 changed files",
  askingGitHub: "Asking GitHub…",
  askingGitea: "Asking Gitea…", // fork: a Gitea pull request (giteaPr, below)
  noPr: "This task has no pull request.",
  noBranch: "This task works in its folder, with no branch of its own, so it has no pull request.",
  openOnGitHub: "Open on GitHub",
  openOnGitea: "Open on Gitea", // fork
  copyLink: "Copy link",
  copied: "Copied",
  checks: "Checks",
  noChecks: "No checks on it.",
};
// A change's word, and a check's: on hover.
export const CHANGE_WORDS = { A: "Added", M: "Changed", D: "Deleted", U: "Conflict" };
export const CHECK_WORDS = { pass: "Passed", fail: "Failed", pending: "Running", skip: "Skipped" };
export const PR_STATES = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

// fork (dmasiero/shepherdr): a task's pull request on Gitea, which herdr-task opened through tea (herdr_task/gitea.py:
// its record says forge "gitea" and the tea login that reaches it). tea(args) runs tea on the task's machine and gives
// { code, stdout, stderr }; the answer is prOf's shape, its checks the commit statuses on its head (warning passes, as
// on Gitea). FORK.md, docs/gitea.md.
export const isGitea = (pr) => pr?.forge === "gitea" && Boolean(pr.login && pr.repo && pr.number);
const GITEA_CHECK = { success: "pass", warning: "pass", skipped: "skip", pending: "pending", failure: "fail", error: "fail" };

export function giteaPrOf(d, statuses = []) {
  const state = d.merged ? "merged" : d.state === "closed" ? "closed" : d.draft || /^\s*(wip:|\[wip\])/i.test(d.title ?? "") ? "draft" : "open";
  // Gitea Actions' links are its server's paths (/owner/repo/actions/runs/3/jobs/0): whole, from the pull request's.
  const whole = (u) => { try { return u ? new URL(u, d.html_url).href : null; } catch { return null; } };
  const checks = statuses.map((c) => ({ name: c.context || "Check", url: whole(c.target_url),
    state: GITEA_CHECK[String(c.status ?? c.state ?? "").toLowerCase()] ?? "pending" }))
    .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
  return { number: d.number, title: d.title, url: d.html_url, state, head: d.head?.ref ?? null, base: d.base?.ref ?? null,
    add: d.additions ?? 0, del: d.deletions ?? 0, files: d.changed_files ?? 0, checks, forge: "gitea" };
}

// { pr } or { error }, as the views' gh readers answer.
export async function giteaPr(tea, pr) {
  const api = async (path) => {
    const r = await tea(["api", "--login", pr.login, path]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "").trim().split("\n")[0] || "Gitea didn't answer.");
    const d = JSON.parse(r.stdout || "null");
    // tea api exits 0 on any HTTP status: Gitea's error is a bare { message }
    if (d && typeof d === "object" && !Array.isArray(d) && typeof d.message === "string" && d.number === undefined && d.statuses === undefined) throw new Error(d.message);
    return d;
  };
  try {
    const d = await api(`repos/${pr.repo}/pulls/${pr.number}`);
    const sha = d?.head?.sha, open = !d?.merged && d?.state !== "closed";
    // Every page of its statuses (at most 20); ones that can't be read are said, never shown as none.
    const statuses = [];
    let checksError = null;
    if (open && /^[0-9a-f]{40,64}$/.test(sha ?? "")) {
      try {
        for (let page = 1; ; page++) {
          if (page > 20) throw new Error("too many statuses");
          const rows = (await api(`repos/${pr.repo}/commits/${sha}/status?limit=50&page=${page}`))?.statuses ?? [];
          statuses.push(...rows);
          if (rows.length < 50) break;
        }
      } catch { checksError = "Couldn't read its checks on Gitea."; }
    }
    return { pr: { ...giteaPrOf(d, checksError ? [] : statuses), ...(checksError ? { checksError } : {}) } };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}
// "No changes against main", "Against main"; "3 files"
export const noChanges = (label) => (label ? `No changes against ${label}` : VIEW_WORDS.noUncommitted);
export const againstLine = (label) => (label ? `Against ${label}` : VIEW_WORDS.uncommitted);
export const filesCount = (n) => `${n.toLocaleString("en")} ${n === 1 ? "file" : "files"}`;

// A folder's entries, as the window's Files lists them (one folder at a time, .git left out, at most PER_FOLDER and
// TOTAL in all): sh -c LIST_DIR files <folder> prints "<d|f>\0<name>\0" each, and fails when it isn't a folder.
export const PER_FOLDER = 500, TOTAL = 5000;
export const LIST_DIR = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
// Its entries, folders first, then by name.
export function dirEntries(stdout) {
  const fields = String(stdout).split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}
// The letter beside a changed file in Files (git status --porcelain=v1 -z): A new, U conflict, D deleted, else M.
export const MARK_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
export function markOf(xy) {
  return xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
}

// gh pr view's JSON as the views show it.
export function prOf(d) {
  const state = d.state === "MERGED" ? "merged" : d.state === "CLOSED" ? "closed" : d.isDraft ? "draft" : "open";
  const checks = (d.statusCheckRollup ?? []).map(checkOf).sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
  return { number: d.number, title: d.title, url: d.url, state, head: d.headRefName, base: d.baseRefName,
    add: d.additions ?? 0, del: d.deletions ?? 0, files: d.changedFiles ?? 0, checks };
}
