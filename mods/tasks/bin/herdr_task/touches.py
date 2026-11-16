"""Touches: each time someone steps into a task (fork: SHEP-63, the first step of "agents that learn
from where the person steps in", designed in SHEP-62).

A touch is a small record on the task, in its list's JSON (t["touches"], the newest MAX):

    {"kind": "message", "at": <ms>, "by": "person", "from": "chat", "log": "<session>/<line uuid>"}

kind: message (words in its chat), stop (an interrupt), ask (a question card answered), note (a
note on one of its artifacts), reopen, back (Working again after ready), fix, review-more, pr (a
pull request comment with a person's words), guide (the Assistant's hc send to it). by: person,
assistant, autopilot (the Assistant on an Autopilot wake), agent, or herdr (Herdr itself noticed,
e.g. its agent at work again: never counted as help). from: where it came from, when known.
log: a pointer to where its words already live (a worker log's line, a pull request comment, an
ask's id), never the words: the person's words stay in the logs they're already in.

Two ways in: the commands that make one (reopen, fix, review-more, resume; `herdr-task touch` for
the service's answered cards and herdr-artifact's notes), and the tick's pass over each working
task's session log (touches_pass), which reads only what's new since its last look. Herdr's own
messages to a worker start with a <herdr-task kind="…"/> tag (TAG) and never count; older
untagged ones are known by their first words (HERDR_OWN). Back-filled once per list from its task
files and the logs still on disk, so `herdr-task stats` starts from today's baseline; reading the
same log again adds nothing (its cursor, and each touch's pointer).
"""

import datetime
import json
import os
import re
import statistics
import time

from .base import Fail, hc_json, now, STORE
from .settings import bare
from .launch import is_coordinator
from .agents import from_person
from .store import locate, read_list, Store, store_files
from .output import say

KINDS = ("message", "stop", "ask", "note", "reopen", "back", "fix", "review-more", "pr", "guide")
BY = ("person", "assistant", "autopilot", "agent", "herdr")
MAX = 50                # touches kept on a task; older ones only as counts (touches_older)
NEAR_MS = 90_000        # an ask, note or fix told by two ways within this is one touch
WAKE_MS = 30 * 60000    # an Assistant's words this soon after an Autopilot wake were Autopilot's
FILL_BUDGET_S = 20      # a tick back-fills lists for at most this long, the rest next time
RECENT_DONE_MS = 3600000  # a task done this recently still has its log read (its last words)


def tag(kind):
    """What starts each of Herdr's own messages to a worker, so a touch never counts it. The chat
    hides a <herdr-…/> tag (core/chat-log.js) and shows the words after it."""
    return f'<herdr-task kind="{kind}"/>\n'


TAGGED = re.compile(r'^\s*<herdr-task\b[^>]*/>')
# Herdr's own messages from before they were tagged (merge, fix, review, resume, switch, provider retry).
HERDR_OWN = re.compile(r"^\s*(?:Merge task \S+ |Shepherdr (?:resumed|restarted) your session|Your Assistant added one review round"
                       r"|Review round \d+ of \d+ for |Your last turn was cut off by the model's provider|Carry on where you left off)")
FIX_OWN = re.compile(r'^\s*Task [A-Z]+-\d+ ".*" can\'t merge yet:', re.S)
PASTED = re.compile(r"</?pasted_content\b[^>]*>")
HC_FROM = re.compile(r'^\s*<hc\s+from="([^"]*)"[^>]*>([\s\S]*)</hc>\s*$')
SELF_CLOSING = re.compile(r"<hc\b[^>]*/>\n?")
MENTION = re.compile(r'<hc task="[^"]*"[^>]*>[\s\S]*?</hc>\n?')
PROGRAM = re.compile(r"^\s*<(?:herdr-[\w-]+|task-notification|local-command|command-|system-reminder|agent-message|user-prompt-submit-hook)")
INTERRUPT = re.compile(r"^\s*\[Request interrupted by user")


# ---- one touch ---------------------------------------------------------------------------------

def _tail(p):
    return str(p or "").rsplit("/", 1)[-1]


def outside(p):
    """A pointer from outside the logs (a command, the service's card, herdr-artifact's note), not a log line."""
    return not p or str(p).split(":", 1)[0] in ("ask", "note", "file")


def add(t, kind, by="person", frm=None, log=None, at=None, why=None):
    """Adds one touch to the task; False when it was there already (the same pointer, or the same
    ask, note or fix told the other way moments apart). why: a reopen's short reason, as given."""
    at = int(at or now())
    ts = t.setdefault("touches", [])
    if log and any(x.get("log") and _tail(x["log"]) == _tail(log) for x in ts):
        return False
    if kind in ("ask", "note", "fix"):
        twin = next((x for x in ts if x["kind"] == kind and abs(x["at"] - at) < NEAR_MS
                     and outside(x.get("log")) != outside(log)), None)
        if twin:
            for k, v in (("from", frm), ("log", log)):
                if v and (not twin.get(k) or k == "from" and twin[k] in ("log", None)):
                    twin[k] = v
            return False
    x = {"kind": kind, "at": at, "by": by}
    if frm:
        x["from"] = frm
    if log:
        x["log"] = log
    if why:
        x["why"] = " ".join(str(why).split())[:200]
    ts.append(x)
    ts.sort(key=lambda y: y["at"])
    while len(ts) > MAX:
        old = ts.pop(0)
        if old.get("by") != "herdr":
            older = t.setdefault("touches_older", {})
            older[old["kind"]] = older.get(old["kind"], 0) + 1
    return True


def wakes(space):
    """An Autopilot space's recent wakes that reached its Assistant: [ms]."""
    try:
        with open(os.path.join(STORE, ".autopilot.json")) as f:
            a = ((json.load(f).get("spaces") or {}).get(bare(space) or "") or {})
    except (OSError, ValueError, AttributeError):
        return []
    return [w["at"] for w in (a.get("wakes") or []) + [a.get("last_wake") or {}]
            if isinstance(w, dict) and w.get("at") and not str(w.get("outcome") or "").startswith("Missed")]


def assistant_or_autopilot(space, at):
    return "autopilot" if any(w <= at <= w + WAKE_MS for w in wakes(space)) else "assistant"


def caller_by(t=None):
    """Who runs this command: the Assistant (or Autopilot), a task's own agent, else the person
    (the window, the web or a terminal of theirs)."""
    me = os.environ.get("HC_TERMINAL_ID")
    k = hc_json("get", me) if me else None
    labels = (k or {}).get("labels") or {}
    if k and is_coordinator(k):
        return assistant_or_autopilot((t or {}).get("space") or labels.get("herdr.space") or labels.get("herdr.coordinator.space"), now())
    if labels.get("herdr.task"):
        return "agent"
    return "person"


def note(s, t, kind, by=None, frm=None, log=None, why=None, at=None):
    """A command's touch on the task (its Store saved with it). Never stops the command."""
    try:
        if add(t, kind, by or caller_by(t), frm, log, at, why):
            s.dirty = True
    except Exception:
        pass


# ---- reading a worker's log --------------------------------------------------------------------

def _ms(stamp):
    try:
        return int(datetime.datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def classify(text, images=False):
    """What one message a worker received was: (kind, by, from), or None when it isn't anyone
    stepping in (Herdr's own, a program's, another agent's, a tool's). by "assistant" is told
    apart from Autopilot later (its time)."""
    s = PASTED.sub("", str(text or "")).strip()
    if INTERRUPT.match(s):
        return ("stop", "person", "chat")
    if TAGGED.match(s) or HERDR_OWN.match(s):
        return None
    m = HC_FROM.match(s)
    if m:
        sender, inner = m.group(1), m.group(2).strip()
        if sender == "artifact":
            return ("note", "person", "viewer")
        if sender == "person":
            return ("message", "person", "secret")  # a secret given in the masked box (herdr-secret)
        if "assistant" in sender:
            inner = PASTED.sub("", inner).strip()
            if TAGGED.match(inner) or HERDR_OWN.match(inner):
                return None
            if FIX_OWN.match(inner):
                return ("fix", "assistant", "assistant")
            return ("guide", "assistant", "assistant")
        return None  # another agent (a reviewer, a helper, another worker)
    s = MENTION.sub("", SELF_CLOSING.sub("", s)).strip()
    if PROGRAM.match(s) or s.startswith("Another Claude session sent a message"):
        return None
    if FIX_OWN.match(s):
        return ("fix", "person", "tasks")
    if not s and not images:
        return None
    return ("message", "person", "chat")


def _content(d):
    c = (d.get("message") or {}).get("content")
    return c if isinstance(c, list) else []


def read_log(t, log):
    """New touches from one of the task's agent logs since its last look (t["touch_logs"]: where
    it stopped, whether its brief was passed, the questions still open). Returns how many."""
    name = os.path.basename(log)
    name = name[:-6] if name.endswith(".jsonl") else name
    cursors = t.setdefault("touch_logs", {})
    cur = cursors.get(name) or {"at": 0}
    try:
        size = os.path.getsize(log)
    except OSError:
        return 0
    if size <= cur["at"]:
        return 0
    added, asks, pos = 0, dict(cur.get("asks") or {}), cur["at"]
    space = t.get("space")
    with open(log, "rb") as f:
        f.seek(pos)
        for raw in f:
            if not raw.endswith(b"\n"):
                break  # a line still being written: read next time
            pos += len(raw)
            if not (b'"user"' in raw or b"user_message" in raw or b"turn_aborted" in raw or b"AskUserQuestion" in raw):
                continue
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(d, dict) or d.get("isSidechain"):
                continue
            at = _ms(d.get("timestamp")) or now()
            ptr = f"{name}/{d.get('uuid') or d.get('timestamp')}"
            # A question card (AskUserQuestion): asked in the agent's line, answered in its result.
            if d.get("type") == "assistant":
                for c in _content(d):
                    if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "AskUserQuestion":
                        asks[c.get("id")] = at
                continue
            if d.get("type") == "user" and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in _content(d)):
                for c in _content(d):
                    if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in asks:
                        asks.pop(c["tool_use_id"])
                        if not c.get("is_error"):
                            added += add(t, "ask", "person", "log", ptr, at)
                continue
            if d.get("isMeta") or d.get("isCompactSummary") or d.get("isVisibleInTranscriptOnly"):
                continue
            if d.get("type") == "event_msg" and (d.get("payload") or {}).get("type") == "turn_aborted":
                if (d["payload"].get("reason") or "interrupted") == "interrupted":
                    added += add(t, "stop", "person", "chat", ptr, at)
                continue
            text = from_person(d)
            if text is None:
                continue
            if not cur.get("brief"):
                cur["brief"] = True  # its first message is its brief (or handoff)
                continue
            got = classify(text, any(isinstance(c, dict) and c.get("type") == "image" for c in _content(d)))
            if not got:
                continue
            kind, by, frm = got
            if by == "assistant":
                by = assistant_or_autopilot(space, at)
            added += add(t, kind, by, frm, ptr, at)
    cur["at"] = pos
    cur["asks"] = {k: v for k, v in asks.items() if k and now() - v < 7 * 86400000} if asks else None
    if not cur["asks"]:
        cur.pop("asks")
    cursors[name] = cur
    return added


def read_logs(t):
    """New touches from all the task's agents' logs: (how many, whether its cursors moved)."""
    n, before = 0, json.dumps(t.get("touch_logs"), sort_keys=True)
    for a in t.get("agents") or []:
        log = a.get("log")
        if log and os.path.isfile(log):
            n += read_log(t, log)
    return n, json.dumps(t.get("touch_logs"), sort_keys=True) != before


def fill_task(t):
    """What a task file already says of someone stepping in, from before touches were kept."""
    n = 0
    if t.get("reopened_at"):
        n += add(t, "reopen", "person", None, f"file:reopen:{t['reopened_at']}", t["reopened_at"])
    for i in range(int(t.get("review_rounds_added") or 0)):
        n += add(t, "review-more", "assistant", None, f"file:review-more:{i}", t.get("ready_at") or t.get("started") or now())
    b = t.get("back") or {}
    if b.get("at"):
        n += add(t, "back", "herdr" if b.get("auto") else "person", None, f"file:back:{b['at']}", b["at"])
    return n


def fill_list(s):
    """Back-fills one list once (its task files, and each task's logs still on disk)."""
    n = 0
    for t in s.data["tasks"]:
        n += fill_task(t) + read_logs(t)[0]
    s.data["touches_filled"] = now()
    s.dirty = True
    return n


def watched(t):
    return t.get("state") in ("running", "ready") or (t.get("state") == "done" and now() - (t.get("done_at") or 0) < RECENT_DONE_MS
                                                       and any(a.get("log") for a in t.get("agents") or []))


def touches_pass(report, folder=None):
    """The tick's look: lists not back-filled yet are (within FILL_BUDGET_S), and each working,
    ready or just-done task's logs are read from where they stopped."""
    start = time.time()
    for p in store_files(folder):
        d = read_list(p)
        if not d or not os.path.isdir(d.get("folder") or ""):
            continue
        fill = not d.get("touches_filled") and time.time() - start < FILL_BUDGET_S
        live = [t for t in d.get("tasks") or [] if watched(t)]
        if not fill and not live:
            continue
        with Store(locate(d["folder"])) as s:
            n = fill_list(s) if fill else 0
            for t in s.data["tasks"]:
                if not fill and watched(t):
                    got, moved = read_logs(t)
                    if got or moved:
                        s.dirty = True
                    n += got
            if fill:
                report.setdefault("touches_filled", []).append(s.loc["folder"])
        if n:
            report.setdefault("touches", []).append({"folder": d["folder"], "added": n})


# ---- herdr-task touch ----------------------------------------------------------------------------

def task_of_terminal(terminal):
    """(folder, id) of the task a terminal works on (its herdr.task label), else None."""
    k = hc_json("get", terminal) if terminal else None
    key = ((k or {}).get("labels") or {}).get("herdr.task") or ""
    slug, _, n = key.rpartition("#")
    if not slug or not n.isdigit():
        return None
    d = read_list(os.path.join(STORE, f"{slug}.json"))
    return (d["folder"], int(n)) if d and d.get("folder") else None


def cmd_touch(args):
    """A touch from outside herdr-task: the service's answered question cards (service/asks.ts),
    herdr-artifact's notes. By task (id and --folder) or by its agent's terminal (--terminal)."""
    if args.kind not in KINDS:
        raise Fail(f"--kind is one of: {', '.join(KINDS)}.")
    if args.by and args.by not in BY:
        raise Fail(f"--by is one of: {', '.join(BY)}.")
    if args.terminal:
        found = task_of_terminal(args.terminal)
        if not found:
            say(args, {"touched": False, "why": "not a task's agent"}, "Not a task's agent: nothing to note.")
            return
        folder, n = found
        ref = None
    else:
        if not args.id:
            raise Fail("Name the task (herdr-task touch SHEP-7 --kind note) or its agent (--terminal t5).")
        folder, ref = args.folder, args.id
    with Store(locate(folder)) as s:
        t = s.find(ref) if ref else next((x for x in s.data["tasks"] if x["id"] == n), None)
        if not t:
            raise Fail("No such task.")
        got = add(t, args.kind, args.by or caller_by(t), args.source, args.log, args.at, args.why)
        if got:
            s.dirty = True
        out = {"task": s.ref(t), "touched": got}
    say(args, out, f"{out['task']}: " + ("noted." if got else "already noted."))


# ---- herdr-task stats ----------------------------------------------------------------------------

HELP_BY = ("person", "assistant", "autopilot")


def helped(t, but=()):
    """Someone stepped in on this task (a touch by the person, the Assistant or Autopilot), kinds
    in `but` left out (answered question cards: "no words")."""
    return any(x.get("by") in HELP_BY and x["kind"] not in but for x in t.get("touches") or []) or \
        any(n for k, n in (t.get("touches_older") or {}).items() if k not in but)


def space_names():
    names = {}
    try:
        with open(os.path.join(STORE, ".autopilot.json")) as f:
            for k, v in (json.load(f).get("spaces") or {}).items():
                if isinstance(v, dict) and v.get("name"):
                    names[k] = v["name"]
    except (OSError, ValueError, AttributeError):
        pass
    try:
        # The window's newest backup of this computer's spaces (a machine with no window running now).
        from .backups import BACKUPS, THIS
        last = sorted(d for d in os.listdir(BACKUPS) if os.path.isfile(os.path.join(BACKUPS, d, f"{THIS}.json")))[-1:]
        for sp in ((read_list(os.path.join(BACKUPS, last[0], f"{THIS}.json")) or {}).get("doc") or {}).get("spaces") or [] if last else []:
            if sp.get("id") and sp.get("name"):
                names[sp["id"]] = sp["name"]
    except Exception:
        pass
    try:
        from .autopilot import window_spaces
        for x in window_spaces() or []:
            if x.get("id") and x.get("name"):
                names[bare(x["id"])] = x["name"]
    except Exception:
        pass
    return names


def week_of(ms):
    d = datetime.date.fromtimestamp(ms / 1000)
    return (d - datetime.timedelta(days=d.weekday())).isoformat()


def summary(tasks):
    """The numbers of one group of tasks (each a task record)."""
    kinds, by = {k: 0 for k in KINDS}, {}
    for t in tasks:
        for x in t.get("touches") or []:
            if x.get("by") in HELP_BY or x["kind"] == "back":
                kinds[x["kind"]] = kinds.get(x["kind"], 0) + 1
            by[x.get("by") or "person"] = by.get(x.get("by") or "person", 0) + 1
        for k, n in (t.get("touches_older") or {}).items():
            kinds[k] = kinds.get(k, 0) + n
    done = [t for t in tasks if t.get("state") == "done"]
    waits = sorted((t["accepted_at"] - t["ready_at"]) / 60000 for t in tasks
                   if t.get("accepted_at") and t.get("ready_at") and t["accepted_at"] >= t["ready_at"])
    no_help = sum(1 for t in done if not helped(t))
    no_words = sum(1 for t in done if not helped(t, ("ask",)))
    help_n = sum(n for k, n in kinds.items() if k != "back")
    return {
        "tasks": len(tasks), "done": len(done), "no_help": no_help,
        "no_help_share": round(no_help / len(done), 2) if done else None,
        # Done with no words to it: only question cards answered (or nothing at all).
        "no_words": no_words, "no_words_share": round(no_words / len(done), 2) if done else None,
        "asks": kinds.get("ask", 0),
        "touches": help_n, "per_task": round(help_n / len(tasks), 2) if tasks else None,
        "kinds": {k: n for k, n in kinds.items() if n}, "by": by,
        "reopens": kinds.get("reopen", 0), "working_again": kinds.get("back", 0), "fixes": kinds.get("fix", 0),
        "ready_to_accept": {"n": len(waits), "median_min": round(statistics.median(waits), 1) if waits else None,
                            "p90_min": round(waits[min(len(waits) - 1, int(len(waits) * 0.9))], 1) if waits else None},
    }


def cmd_stats(args):
    """Per space: tasks, touches by kind, done with no help, Ready to Accept, reopens (from the
    touches: no log is read here, except to back-fill a list once)."""
    weeks = getattr(args, "weeks", None)
    since = now() - weeks * 7 * 86400000 if weeks else 0
    want = bare(args.space) if getattr(args, "space", None) else None
    names = space_names()
    groups = {}
    for p in store_files(None):
        d = read_list(p)
        if not d or not os.path.isdir(d.get("folder") or ""):
            continue
        if not d.get("touches_filled"):
            try:
                with Store(locate(d["folder"])) as s:
                    fill_list(s)
                    d = s.data
            except Fail:
                pass  # read only here: counted as it is
        for t in d.get("tasks") or []:
            if not t.get("started") or t["started"] < since:
                continue
            sp = bare(t.get("space")) or ""
            # By name: a space made again (a new id, the same name) is the same space to the person. One the
            # window can't name (none runs here, or it's gone) goes by its folder's name.
            name = names.get(sp) or os.path.basename(d["folder"])
            if want and want not in (sp, name):
                continue
            g = groups.setdefault(name, {"spaces": [], "name": name, "tasks": []})
            if sp and sp not in g["spaces"]:
                g["spaces"].append(sp)
            g["tasks"].append(t)
    rows = []
    for g in groups.values():
        row = {"name": g["name"], "spaces": g["spaces"], **summary(g["tasks"])}
        by_week = {}
        for t in g["tasks"]:
            by_week.setdefault(week_of(t["started"]), []).append(t)
        row["weeks"] = [{"week": w, **{k: v for k, v in summary(ts).items() if k in ("tasks", "done", "no_help", "no_words", "touches", "asks", "reopens")}}
                        for w, ts in sorted(by_week.items())]
        rows.append(row)
    rows.sort(key=lambda r: -r["tasks"])
    every = summary([t for g in groups.values() for t in g["tasks"]])
    out = {"spaces": rows, "all": every, **({"weeks": weeks} if weeks else {})}
    if getattr(args, "json", False):
        print(json.dumps(out))
        return
    if not rows:
        print("No tasks started yet" + (f" in the last {weeks} weeks." if weeks else "."))
        return
    pct = lambda x: "-" if x is None else f"{round(x * 100)}%"
    mins = lambda x: "-" if x is None else f"{x:g} min"
    w = max(len("Space"), *(len(r["name"]) for r in rows))
    print(f"{'Space':<{w}}  Tasks  Done  No help  No words  Touches  Asks  Reopens  Ready→Accept (median)")
    for r in rows + [{"name": "All", **every}]:
        print(f"{r['name']:<{w}}  {r['tasks']:>5}  {r['done']:>4}  {pct(r['no_help_share']):>7}  {pct(r['no_words_share']):>8}  "
              f"{r['touches']:>7}  {r['asks']:>4}  {r['reopens']:>7}  {mins(r['ready_to_accept']['median_min'])}")
    print("No help: done with no touch at all. No words: done with nothing but question cards answered.")
    if every["kinds"]:
        print("Touches by kind: " + " · ".join(f"{k} {n}" for k, n in sorted(every["kinds"].items(), key=lambda x: -x[1])))
    print(f"Ready→Accept slowest tenth: over {mins(every['ready_to_accept']['p90_min'])}. Working again after ready: {every['working_again']}.")
