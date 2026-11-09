"""Fork (dmasiero/shepherdr): Gitea pull requests through tea, Gitea's command line, as GitHub's go
through gh (github.py). Which forge a repo is on, and each pull request call a Gitea repo needs,
answering in the shapes gh's do, so ready, the tick, the news and Accept treat both alike.
FORK.md, docs/gitea.md.

A repo's forge: its git config shepherdr.forge (auto when unset). auto reads the push remote's host:
a GitHub host is GitHub, as upstream reads it (tea is never asked); a host one of tea's logins
serves (its address or its SSH host), or one named gitea, is Gitea; any other is upstream's (gh repo
view, else no pull requests: tasks merge here). gitea or github say it outright.

forge() gives github.github() a Gitea target, {forge: "gitea", repo, login, web, host}, in place of
GitHub's "owner/name"; a repo that says Gitea but tea can't reach gives {forge: "gitea", error}, so
ready says why and nothing merges here. A task's Gitea pull request is {number, url, repo,
forge: "gitea", login, web}: login is the tea login that reaches it, web its server's address."""

import datetime
import json
import os
import re
import subprocess
import time

from .base import Fail, git, now

TEA = os.environ.get("HERDR_TASK_TEA") or "tea"
MISSING = "tea (Gitea's command line) isn't installed here: install it and log in (tea login add)"
MERGE_FAILED = "Gitea didn't merge it"
PAGE = 50
SHA = re.compile(r"^[0-9a-f]{40,64}$")
GITHUB_HOST = re.compile(r"^(?:[^.]+\.)*(?:github\.com|ghe\.com)$")
KEEP_MS = 3600000  # as github(): a repo's forge is read again after an hour

# A Gitea commit status in GitHub's words (github.BAD and PENDING sort them): warning blocks nothing.
STATE = {"success": "SUCCESS", "warning": "NEUTRAL", "failure": "FAILURE", "error": "ERROR",
         "pending": "PENDING", "skipped": "SKIPPED"}
REVIEW = {"REQUEST_CHANGES": "CHANGES_REQUESTED", "COMMENT": "COMMENTED"}


def no_login(host):
    return f"tea isn't logged in to {host} (tea login list has none for it): tea login add --url https://{host}"


def on(task):
    """The task's pull request is on Gitea."""
    return (task.get("pr") or {}).get("forge") == "gitea"


def word(task):
    """The task's forge, as said to people and agents."""
    return "Gitea" if on(task) else "GitHub"


def is_target(repo):
    """github()'s answer is a Gitea repo (GitHub's is its "owner/name")."""
    return isinstance(repo, dict) and repo.get("forge") == "gitea"


# ---- tea ------------------------------------------------------------------------------------

def tea(*args, data=None, timeout=60):
    """tea with these words: (ok, stdout, stderr). Not installed is said plainly (Fail)."""
    try:
        r = subprocess.run([TEA, *args], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           universal_newlines=True, timeout=timeout, env={**os.environ, "NO_COLOR": "1"})
    except FileNotFoundError:
        raise Fail(MISSING)
    except subprocess.TimeoutExpired:
        raise Fail(f"tea didn't answer in {timeout}s")
    return r.returncode == 0, r.stdout, r.stderr


def api(login, method, path, body=None, timeout=60):
    """One call of Gitea's API through a tea login (`tea api -i` writes Gitea's HTTP status to
    stderr, and exits 0 on any status): (status, body), the body JSON when it is, else its text."""
    args = ["api", "--login", login, "-i", "-X", method, *(["-d", "@-"] if body is not None else []), path]
    ok, out, err = tea(*args, data=json.dumps(body) if body is not None else None, timeout=timeout)
    m = re.search(r"^HTTP/[\d.]+ (\d{3})", err, re.M)
    if not ok or not m:
        line = next((x for x in (err or out).splitlines() if x.strip()), "no output")
        raise Fail(f"tea failed: {line[:300]}")
    try:
        answer = json.loads(out) if out.strip() else None
    except ValueError:
        answer = out
    return int(m.group(1)), answer


def said(code, body):
    """Gitea's own words for an answer that was no success."""
    msg = body.get("message") if isinstance(body, dict) else (body.strip().split("\n")[0] if isinstance(body, str) else "")
    return (f"Gitea answered HTTP {code}" + (f": {str(msg)[:300]}" if msg else "")
            + (" (tea's token for it was refused: tea login add again)" if code == 401 else ""))


def call(pr, method, path, body=None, timeout=60):
    """A call for the pull request's repo that must succeed: its body (Fail with Gitea's words)."""
    code, answer = api(pr["login"], method, path, body, timeout)
    if not 200 <= code < 300:
        raise Fail(said(code, answer))
    return answer


def pages(pr, path, most=5):
    """A Gitea list, page by page, at most `most` pages: more than that is never taken as all."""
    out = []
    for page in range(1, most + 2):
        rows = call(pr, "GET", f"{path}{'&' if '?' in path else '?'}limit={PAGE}&page={page}")
        if not isinstance(rows, list):
            raise Fail("Gitea didn't return a list")
        if page > most and rows:
            raise Fail("Too many Gitea results for one read")
        out += rows
        if len(rows) < PAGE:
            return out
    return out


# ---- which forge ----------------------------------------------------------------------------

def remote_parts(url):
    """(host, "owner/name") of a remote's address (ssh://git@host:2222/o/r.git, git@host:o/r,
    https://host/o/r); None for a folder."""
    text = (url or "").strip()
    if not text or text.startswith(("/", ".")) or text.lower().startswith("file:"):
        return None
    m = re.match(r"^(?:[a-z+]+://)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]+([^/]+/[^/]+?)(?:\.git)?/?$", text, re.I)
    return (m.group(1).lower(), m.group(2)) if m else None


def remote_urls(folder, remote):
    """Where the remote's pushes go, the two ways it may be said: as written (its push address, else
    its address: an insteadOf rewrite may hide the host), then as git pushes to it."""
    written = git(folder, "config", "--get", f"remote.{remote}.pushurl")[1] or git(folder, "config", "--get", f"remote.{remote}.url")[1]
    used = git(folder, "remote", "get-url", "--push", remote)[1]
    return [u for u in dict.fromkeys((written, used)) if u]


def host_of(url):
    return re.split(r"[/:@]", re.sub(r"^[a-z+]+://", "", url or "", flags=re.I))[0].lower()


def logins():
    """tea's logins: [{name, url, ssh_host}] (Fail when tea can't run)."""
    ok, out, err = tea("login", "list", "--output", "json", timeout=20)
    if not ok:
        first = (err or out).strip().splitlines()
        raise Fail(f"tea failed: {first[0][:300] if first else 'no output'}")
    try:
        rows = json.loads(out.strip() or "[]")
    except ValueError:
        raise Fail("tea login list didn't return a list")
    return [r for r in rows if isinstance(r, dict) and r.get("name")] if isinstance(rows, list) else []


def target(remote, urls, said_forge):
    """The repo's Gitea, {forge, repo, login, web, host}, or None when it isn't on Gitea. Fail when
    it says Gitea (shepherdr.forge, or a host named gitea) but tea can't reach it."""
    found = [p for p in map(remote_parts, urls) if p]
    named = said_forge == "gitea" or any("gitea" in host for host, _ in found)
    if not found:
        if said_forge == "gitea":
            raise Fail(f"shepherdr.forge is gitea, but {remote} ({urls[0] if urls else 'none'}) isn't a Gitea address")
        return None
    try:
        known = logins()
    except Fail as e:
        if not named and str(e) == MISSING:
            return None  # no tea, and nothing says Gitea: upstream's
        raise
    for host, repo in found:
        login = next((x for x in known if host in (host_of(x.get("url") or ""), str(x.get("ssh_host") or "").lower())), None)
        if login:
            return {"forge": "gitea", "repo": repo, "login": login["name"], "web": (login.get("url") or f"https://{host}").rstrip("/"), "host": host}
    if named:
        raise Fail(no_login(found[0][0]))
    return None


def decide(folder, remote_of):
    """The repo's forge, read now: {kind: "github" | "gitea" | None, target?}."""
    said_forge = git(folder, "config", "--get", "shepherdr.forge")[1].lower()
    if said_forge == "github":
        return {"kind": "github"}
    remote = remote_of(folder)
    urls = remote_urls(folder, remote)
    hosts = [p[0] for p in map(remote_parts, urls) if p]
    if said_forge != "gitea" and hosts and GITHUB_HOST.match(hosts[0]):
        return {"kind": "github"}
    t = target(remote, urls, said_forge)
    return {"kind": "gitea", "target": t} if t else {"kind": None}


def forge(s, remote_of):
    """github()'s answer for a Gitea repo: its target, an error target when it says Gitea but tea
    can't reach it, or None for any other repo (upstream's github() decides). Read again after an
    hour; a failure is never kept."""
    if s.loc["kind"] != "repo":
        return None
    g = s.data.get("forge") or {}
    if not g or now() - g.get("at", 0) >= KEEP_MS:
        try:
            g = {**decide(s.loc["folder"], remote_of), "at": now()}
        except Fail as e:
            return {"forge": "gitea", "error": str(e)}
        s.data["forge"] = g
        s.dirty = True
    return g.get("target") if g.get("kind") == "gitea" else None


def local_merge_refused(s, remote_of):
    """Why a task in this repo can't merge here, or None: a Gitea repo merges only through its pull
    request (ready opens it), and one that says Gitea but tea can't reach never merges here. Read
    now, without gh: GitHub's and other repos' answer is None."""
    if s.loc["kind"] != "repo":
        return None
    try:
        d = decide(s.loc["folder"], remote_of)
    except Fail as e:
        return f"Its repo says Gitea, but: {e}"
    return ("Its repo is on Gitea, where it merges only through its pull request, which ready opens: ask its agent "
            "to run ready again.") if d["kind"] == "gitea" else None


# ---- pull requests --------------------------------------------------------------------------

def root(pr):
    return f"repos/{pr['repo']}"


def own(p, branch):
    """A pull request from this repo's own branch (never a fork's branch of the same name)."""
    head, base = p.get("head") or {}, p.get("base") or {}
    if head.get("repo_id") is not None and base.get("repo_id") is not None and head["repo_id"] != base["repo_id"]:
        return False
    return head.get("ref") == branch


def record(t, p):
    """The task's record of a pull request ({number, url} as gh's lists give them) on target t."""
    return {"number": p["number"], "url": p["url"], "repo": t["repo"], "forge": "gitea", "login": t["login"], "web": t["web"]}


def shaped(p):
    """A Gitea pull request in the fields gh's lists give (pr_adopt, pr_merged)."""
    mc = p.get("merge_commit_sha")
    return {"number": p["number"], "url": p.get("html_url") or "", "baseRefName": (p.get("base") or {}).get("ref"),
            "headRefOid": (p.get("head") or {}).get("sha"), "mergeCommit": {"oid": mc} if SHA.match(mc or "") else None}


def usable(t):
    if t.get("error"):
        raise Fail(t["error"])


WIP = re.compile(r"^\s*(wip:|\[wip\])\s*", re.I)


def unwip(pr, title=None):
    """Takes Gitea's work-in-progress mark off its title (one opened by hand as WIP: is adopted by
    ready): Gitea refuses to merge it while it's there."""
    if title is None:
        title = (call(pr, "GET", f"{root(pr)}/pulls/{pr['number']}") or {}).get("title") or ""
    if WIP.match(title):
        call(pr, "PATCH", f"{root(pr)}/pulls/{pr['number']}", {"title": WIP.sub("", title, count=1)})


def comment(pr, body):
    call(pr, "POST", f"{root(pr)}/issues/{pr['number']}/comments", {"body": body})


def pr_adopt(task, t):
    """As github.pr_adopt: the open pull request for the task's branch (opened by hand or by its
    agent), only from this repo, into the task's base, at the branch's tip here; recorded."""
    if t.get("error"):
        return None
    tip_ok, tip, _ = git(task["worktree"], "rev-parse", task["branch"])
    base = task.get("base") or "main"
    try:
        found = next((p for p in pages(t, f"{root(t)}/pulls?state=open") if own(p, task["branch"])
                      and (p.get("base") or {}).get("ref") == base and tip_ok and (p.get("head") or {}).get("sha") == tip), None)
    except Fail:
        found = None
    if found:
        task["pr"] = record(t, shaped(found))
    return task["pr"] if found else None


def pr_merged(task, t):
    """As github.pr_merged: the merged pull request for the task's branch (from this repo, into its
    base) in gh's fields, or None."""
    if t.get("error"):
        return None
    try:
        rows = pages(t, f"{root(t)}/pulls?state=closed")
    except Fail:
        return None
    base = task.get("base") or "main"
    return next((shaped(p) for p in rows if p.get("merged") and own(p, task["branch"]) and (p.get("base") or {}).get("ref") == base), None)


def pr_open(s, task, t, summary=None):
    """After github.pr_open pushed the branch: keeps the task's open pull request (its summary as a
    comment), else adopts the branch's open one, else opens one, as gh does on GitHub."""
    usable(t)
    pr = task.get("pr") or {}
    if pr.get("number") and on(task):
        try:
            p = call(pr, "GET", f"{root(pr)}/pulls/{pr['number']}") or {}
        except Fail:
            p = {}
        if p.get("state") == "open" and not p.get("merged"):
            unwip(pr, p.get("title") or "")
            if summary:
                comment(pr, summary)
            return pr
    if pr_adopt(task, t):
        unwip(task["pr"])
        if summary:
            comment(task["pr"], summary)
        return task["pr"]
    # SHEP-59, as on GitHub: never a second pull request for a branch that already had one merged.
    done = pr_merged(task, t)
    if done:
        raise Fail(f"Pull request #{done['number']} for {task['branch']} is already merged, and {task['branch']} has commits "
                   "since. Put them on a new branch (a new task) rather than a second pull request.")
    body = (task.get("prompt") or "").strip() or task["title"]
    if summary:
        body += "\n\n## Summary\n\n" + summary.strip()
    if (task.get("details") or "").strip():
        body += "\n\n## Details\n\n" + task["details"].strip()
    try:
        p = call(t, "POST", f"{root(t)}/pulls", {"head": task["branch"], "base": task.get("base") or "main",
                                               "title": f"{s.ref(task)} {task['title']}", "body": body}, timeout=120)
    except Fail as e:
        raise Fail(f"Couldn't open a pull request: {e}")
    if not isinstance(p, dict) or not isinstance(p.get("number"), int) or not p.get("html_url"):
        raise Fail("Couldn't open a pull request: Gitea returned no pull request")
    task["pr"] = record(t, shaped(p))
    return task["pr"]


def required(pr, base):
    """The status checks the base's branch protection requires, by name (only repo admins may read
    them; a pattern with * names none to wait for)."""
    try:
        rules = call(pr, "GET", f"{root(pr)}/branch_protections")
    except Fail:
        return []
    if not isinstance(rules, list):
        return []

    def covers(rule):
        if "*" not in rule:
            return rule == base
        rx = re.escape(rule).replace(r"\*\*", "\0").replace(r"\*", "[^/]*").replace("\0", ".*")
        return re.fullmatch(rx, base) is not None
    out = []
    for r in rules:
        if isinstance(r, dict) and r.get("enable_status_check") and covers(r.get("rule_name") or r.get("branch_name") or ""):
            out += [c for c in r.get("status_check_contexts") or [] if c and "*" not in c and c not in out]
    return out


def checks(pr, sha, base):
    """The commit statuses on its head (Gitea Actions' and any other CI's), as gh's
    statusCheckRollup: {name, context, state, targetUrl}; a required one not shown yet is pending."""
    if not SHA.match(sha or ""):
        raise Fail("Gitea returned an invalid pull request head")
    out = []
    for page in range(1, 21):
        r = call(pr, "GET", f"{root(pr)}/commits/{sha}/status?limit={PAGE}&page={page}") or {}
        rows = (r.get("statuses") or []) if isinstance(r, dict) else []
        for x in rows:
            link = x.get("target_url") or ""
            out.append({"name": x.get("context") or "Check", "context": x.get("context") or "",
                        "state": STATE.get(str(x.get("status") or x.get("state") or "").lower(), "PENDING"),
                        "targetUrl": link if not link or re.match(r"^https?://", link) else pr["web"] + ("" if link.startswith("/") else "/") + link})
        if len(rows) < PAGE:
            break
    else:
        raise Fail("Too many Gitea commit statuses for one read")
    for name in required(pr, base):
        if not any(c["context"] == name for c in out):
            out.append({"name": name, "context": name, "state": "PENDING"})
    return out


def state_of(p):
    return "MERGED" if p.get("merged") else "CLOSED" if p.get("state") == "closed" else "OPEN"


def pr_view(task, settle=1.5):
    """The task's pull request as github.pr_view reads gh's: {state, mergeable, headRefOid,
    statusCheckRollup, mergeCommit, title}; None when Gitea didn't answer. Gitea says unmergeable
    while it is still checking a new head: asked once more before it counts as a conflict. No
    reviewDecision or mergeStateStatus: Gitea's merge says so when its rules refuse."""
    pr = task["pr"]
    try:
        p = call(pr, "GET", f"{root(pr)}/pulls/{pr['number']}")
        if state_of(p) == "OPEN" and p.get("mergeable") is False and settle:
            time.sleep(settle)
            p = call(pr, "GET", f"{root(pr)}/pulls/{pr['number']}")
        state, head, mc = state_of(p), (p.get("head") or {}).get("sha") or "", p.get("merge_commit_sha")
        return {"state": state, "mergeable": "CONFLICTING" if state == "OPEN" and p.get("mergeable") is False else "MERGEABLE",
                "headRefOid": head, "title": p.get("title") or "",
                "statusCheckRollup": checks(pr, head, (p.get("base") or {}).get("ref") or "") if state == "OPEN" else [],
                "mergeCommit": {"oid": mc} if state == "MERGED" and SHA.match(mc or "") else None}
    except (Fail, AttributeError, TypeError):
        return None


def pr_merge(task, v):
    """Merges it in the repo's own default style (a merge commit unless it says otherwise) while its
    head is still the one read (as gh's --match-head-commit), and deletes its branch there (as gh's
    --delete-branch): (ok, "", why). Gitea has no merge queue: done at once."""
    pr = task["pr"]
    try:
        unwip(pr, v.get("title"))  # put back by hand since ready took it off
        style = (call(pr, "GET", root(pr)) or {}).get("default_merge_style") or "merge"
        code, body = api(pr["login"], "POST", f"{root(pr)}/pulls/{pr['number']}/merge",
                         {"Do": style, "head_commit_id": v.get("headRefOid") or "", "delete_branch_after_merge": True}, timeout=120)
    except (Fail, AttributeError) as e:
        return False, "", str(e)
    if 200 <= code < 300:
        return True, "", ""
    if code in (405, 409):
        again = pr_view(task, settle=0) or {}
        if again.get("mergeable") == "CONFLICTING":
            return False, "", f"it conflicts with the base branch ({said(code, body)})"
    return False, "", said(code, body)


def when(text):
    """Gitea's time (2026-11-03T10:00:00Z, or with an offset) as ms, or None."""
    try:
        d = datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None
    return int(d.timestamp() * 1000) if d.tzinfo else None


def pr_comments(pr):
    """Its published reviews, their line comments and its comments with words, oldest first, as
    ghnews.pr_comments reads GitHub's: {id, at, who, body, url, state?, where?}; None when Gitea
    didn't answer."""
    try:
        reviews = pages(pr, f"{root(pr)}/pulls/{pr['number']}/reviews")
        notes = pages(pr, f"{root(pr)}/issues/{pr['number']}/comments")
        sent = [r for r in reviews if isinstance(r, dict) and r.get("id") is not None and r.get("state") not in ("PENDING", "REQUEST_REVIEW")]
        lines = []
        for r in sent:
            if (r.get("comments_count") or 0) > 0:
                lines += [(r, c) for c in call(pr, "GET", f"{root(pr)}/pulls/{pr['number']}/reviews/{r['id']}/comments") or []]
    except Fail:
        return None
    page = f"{pr['web']}/{pr['repo']}/pulls/{pr['number']}"
    out = []

    def add(kind, row, at, **extra):
        if not isinstance(row, dict) or row.get("id") is None or at is None:
            return
        out.append({"id": f"{kind}{row['id']}", "at": at, "who": ((row.get("user") or {}).get("login") or "someone")[:64],
                    "body": (row.get("body") or "").strip(), "url": row.get("html_url") or page, **extra})
    for r in sent:
        add("r", r, when(r.get("submitted_at") or r.get("created_at")), **({"state": REVIEW.get(r["state"], r["state"])} if r.get("state") else {}))
    for r, c in lines:
        at = c.get("line") or c.get("position") or c.get("original_position")
        add("c", c, when(r.get("submitted_at") or c.get("created_at")),
            **({"where": c["path"] + (f":{at}" if at else "")} if c.get("path") else {}))
    for n in notes:
        add("i", n, when(n.get("created_at")))
    return sorted(out, key=lambda c: (c["at"], c["id"]))
