"""fork: SHEP-64: Lessons, step 2 of 5 (designed in SHEP-62): a worker drafts up to 3 lessons at ready, from
where the person stepped into its task (touches.py), and Herdr checks them before they're kept on the task as
candidates (t["lessons"], state pending) for the person's Keep, Edit or Drop (step 3).

A candidate: {id, text, scope, key, state, at, from}: id "l-<task id>-<n>"; scope repo (the repo's AGENTS.md),
space (this space's later briefs), you (the person's, every space) or shepherdr (Shepherdr's makers: Feedback);
key: feedback.key_of(text), its words that say something; from: "lesson" (--lesson) or "agents-md" (--agents-md,
which stays the task's "For AGENTS.md" line too; step 3: news and show leave it to the person's card).

Checks, before anything changes (ready is refused, as for a long summary): one line of at most MAX_TEXT
characters; nothing feedback.redact() would hide but home paths (a key, a token, an e-mail, a host, an
address, a machine's or person's name); no password said in plain words (redact misses those: the design's
proof); no word of a secret this agent can use (herdr-secret masks it, so its value is never read here) nor a
secret-looking word from a line the person sent near "password", "code", "key"... Repeats (the same key as a
pending lesson in this list, a kept one in settings, or a line of the repo's AGENTS.md for repo scope) are
dropped, not refused: the worker hears which.

The switch: settings.json `lessons.on` at Everywhere or a space (default on). Off: briefs carry no lesson
words, ready ignores --lesson (still accepts it) and news says nothing of lessons. Kept lessons (step 3) go
under `lessons.kept` beside it, so they stay saved while it's off.

fork: SHEP-65: step 3, the person's Keep, Edit or Drop: see "step 3" below.
"""

import json
import os
import re
import shutil
import subprocess

from .base import Fail, HOME, now
from . import settings as _settings
from .settings import DEFAULTS, bare, read_settings
from .feedback import HOME_PATH, key_of, redact, words_of

SCOPES = ("repo", "space", "you", "shepherdr")
SCOPE_WORDS = {"repo": "this repo's AGENTS.md", "space": "this space", "you": "you, every space", "shepherdr": "Shepherdr's makers"}
MAX_PER_READY = 3
MAX_TEXT = 200

# A line of worker.md that teaches lessons: left out of a brief while lessons are off (launch.py).
RULE_HEAD = "- Lessons, when the person stepped in:"
RULE = (RULE_HEAD + " if the person (or the Assistant for them) had to step into this task (a correction, a go-ahead, "
        "a standing rule like \"you don't have to ask for each one\", an answer you had to ask for), draft up to 3 lessons "
        "with your ready command, each `--lesson \"<rule>\" --scope repo|space|you|shepherdr`, so the next task needs "
        "them less. Only from those moments: a go-ahead or a standing rule becomes a permission or a habit (\"Record "
        "and commit a paid receipt's row without asking\"); a one-off fact (a record updated, a login done, which "
        "machine) or a one-time \"Send it\" is not a lesson. Each one rule, short and imperative, true for the next task "
        "too, at most 200 characters, never quoting the person and never a secret, a password or a name. Scope: repo "
        "(setting up or testing this repo: AGENTS.md), space (how work goes in this space), you (how the person likes "
        "to work everywhere), shepherdr (Shepherdr itself should change). No stepping in, no lessons. A lesson can't "
        "change what permission prompts or question cards ask. The person keeps, edits or drops each one; nothing "
        "changes until they keep it.\n")

# A password said in plain words ("the admin password is Hunter2x!"): redact() leaves these.
SAID = re.compile(r"(?i)\b(?:password|passcode|passphrase|passwd|pin|secret|token|api[ _-]?key)s?\b\W{0,3}(?:is|was|are|=|:|of|for)?\s*[\"'`]?\S+")
# Words near which a person's line may hold a secret: its secret-looking words are refused in a lesson.
NEAR = re.compile(r"(?i)\b(?:password|passcode|passphrase|passwd|pin|code|key|token|secret|login|credentials?)s?\b")
TOKEN = re.compile(r"\S+")


# ---- the switch -----------------------------------------------------------------------------

def _layer_on(layer):
    v = layer.get("lessons") if isinstance(layer, dict) else None
    v = v.get("on") if isinstance(v, dict) else None
    return v if isinstance(v, bool) else None


def lessons_on(space=None, d=None):
    """Settings › Agents › Lessons in a space: its own `lessons.on`, else Everywhere's, else on."""
    d = read_settings() if d is None else d
    own = (d.get("spaces") or {}).get(bare(space)) if space else None
    for layer in (own, d.get("everywhere")):
        v = _layer_on(layer)
        if v is not None:
            return v
    return DEFAULTS["lessons"]["on"]


def write_on(space, value):
    """Sets `lessons.on` at one level (space None: Everywhere's); None unsets it there (a space then
    follows Everywhere). Refused on a copy the window pushed here, as write_autopilot is."""
    def edit(part):
        if value is None:
            part.pop("on", None)
        else:
            part["on"] = bool(value)
    _settings.write_lessons(space, edit)


# ---- the brief's words ----------------------------------------------------------------------

def without_rule(text):
    """worker.md's words without its lessons line (lessons off)."""
    return "\n".join(x for x in str(text).split("\n") if not x.startswith(RULE_HEAD))


# ---- drafts at ready ------------------------------------------------------------------------

def kept_lessons(d, space=None):
    """Lessons kept in settings (step 3 writes them: `lessons.kept` at Everywhere and each space), and
    retired ones (kept with off: true, so they aren't drafted again)."""
    out = []
    layers = [d.get("everywhere")] + ([(d.get("spaces") or {}).get(bare(space))] if space else list((d.get("spaces") or {}).values()))
    for layer in layers:
        part = layer.get("lessons") if isinstance(layer, dict) else None
        kept = part.get("kept") if isinstance(part, dict) else part if isinstance(part, list) else None
        out += [x for x in kept or [] if isinstance(x, dict) and x.get("text")]
    return out


def agents_md_keys(folder):
    """The keys of the repo's AGENTS.md lines (a repo lesson already there is a repeat)."""
    keys = set()
    for name in ("AGENTS.md", "CLAUDE.md"):
        try:
            with open(os.path.join(folder, name), encoding="utf-8", errors="replace") as f:
                for raw in f:
                    line = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", raw).strip()
                    if len(words_of(line)) >= 2:
                        keys.add(key_of(line))
        except OSError:
            pass
    return keys


def person_lines(t):
    """What the person (or the Assistant for them) sent this task's agents, after each brief: their
    messages and the answers to question cards, from the session logs, read here only to check drafts."""
    from .agents import from_person
    from .touches import classify
    out = []
    for a in t.get("agents") or []:
        log = a.get("log")
        if not log or not os.path.isfile(log):
            continue
        brief, asks = False, set()
        try:
            f = open(log, "rb")
        except OSError:
            continue
        with f:
            for raw in f:
                if not (b'"user"' in raw or b"user_message" in raw or b"AskUserQuestion" in raw):
                    continue
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                if not isinstance(d, dict) or d.get("isSidechain"):
                    continue
                content = (d.get("message") or {}).get("content")
                content = content if isinstance(content, list) else []
                if d.get("type") == "assistant":
                    asks |= {c.get("id") for c in content if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "AskUserQuestion"}
                    continue
                results = [c for c in content if isinstance(c, dict) and c.get("type") == "tool_result"]
                if results:
                    for c in results:
                        if c.get("tool_use_id") in asks:
                            body = c.get("content")
                            out.append(body if isinstance(body, str) else " ".join(str(x.get("text") or "") for x in body or [] if isinstance(x, dict)))
                    continue
                text = from_person(d)
                if text is None or d.get("isMeta"):
                    continue
                if not brief:
                    brief = True  # its first message is its brief (or handoff)
                    continue
                if classify(text):
                    out.append(text)
    return out


def secretish(word):
    """A word that could be a password or code: with a digit, a symbol inside, or mixed case."""
    w = word.strip(".,;:!?()[]{}\"'`")
    if len(w) < 4 or re.fullmatch(r"[a-z]+|[A-Z][a-z]+|[A-Z]+", w):
        return False
    return bool(re.search(r"\d", w) or re.search(r"[A-Za-z][^\w\s][A-Za-z0-9]", w) or re.search(r"[a-z][A-Z]", w)) or word != w


def near_words(lines):
    """Secret-looking words from lines that speak of a password, a code, a key..."""
    out = set()
    for line in lines:
        if NEAR.search(line):
            out |= {w.strip(".,;:!?()[]{}\"'`").lower() for w in TOKEN.findall(line) if secretish(w)}
    return out


def secret_names():
    """The names of the secrets this agent can use (herdr-secret list), [] without it."""
    hs = shutil.which("herdr-secret")
    if not hs or not os.environ.get("HC_TERMINAL_ID"):
        return []
    try:
        r = subprocess.run([hs, "list"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return []
    return [m.group(1) for m in re.finditer(r"^([A-Za-z_][A-Za-z0-9_]*) \(", r.stdout, re.M)] if r.returncode == 0 else []


def holds_secret(texts, names=None):
    """Indexes of texts holding a secret value this agent can use: herdr-secret runs `cat` with them
    and masks every value in its output, so a text that comes back changed held one. The values never
    reach herdr-task."""
    names = secret_names() if names is None else names
    hs = shutil.which("herdr-secret")
    if not names or not hs or not texts:
        return set()
    body = "\n".join(" ".join(x.split()) for x in texts) + "\n"
    try:
        r = subprocess.run([hs, "run", ",".join(names), "--", "cat"], input=body, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return set()
    if r.returncode != 0:
        return set()
    back = r.stdout.split("\n")
    return {i for i, x in enumerate(body.split("\n")[:-1]) if i >= len(back) or back[i] != x}


def tilde(text):
    """Home paths made ~, as redact() makes them."""
    home = HOME.rstrip("/")
    return HOME_PATH.sub("~", text.replace(home + "/", "~/") if home else text)


def private_part(text):
    """What redact() would hide in a draft beyond home paths (made ~), as plain words, else None."""
    plain = tilde(text)
    out = redact(plain)
    if out == plain:
        return None
    kinds = []
    for mark, words in (("<redacted>", "a key, token or password"), ("<email>", "an e-mail address"), ("<host>", "a tailnet name"),
                        ("<ip>", "an IP address"), ("<name>", "a machine's or person's name")):
        if mark in out and mark not in plain:
            kinds.append(words)
    return ", ".join(kinds) or "something private"


def drafts(args):
    """The --lesson/--scope pairs, in order: [(text, scope)]; refused when they don't pair up."""
    texts = [" ".join(str(x or "").split()) for x in getattr(args, "lesson", None) or []]
    scopes = list(getattr(args, "scope", None) or [])
    if not texts and not scopes:
        return []
    if len(scopes) != len(texts):
        raise Fail(f"Give each --lesson its own --scope ({'|'.join(SCOPES)}), right after it: {len(texts)} lesson"
                   f"{'s' if len(texts) != 1 else ''}, {len(scopes)} scope{'s' if len(scopes) != 1 else ''}.")
    return list(zip(texts, scopes))


def why_not(text, held, near, long_ok=False):
    """Why a lesson's words can't be kept ("is empty", "holds ..."), else None. held: it holds a
    secret's value (holds_secret); near: near_words of the person's lines."""
    if not text:
        return "is empty"
    if len(text) > MAX_TEXT and not long_ok:
        return f"is {len(text)} characters: one short rule, {MAX_TEXT} at most"
    if held:
        return "holds the value of a secret you can use: never put one in a lesson"
    if SAID.search(text):
        return "says a password, token or key in plain words: a lesson never holds one"
    if near & {w.strip(".,;:!?()[]{}\"'`").lower() for w in TOKEN.findall(text) if secretish(w)}:
        return "shares a word with a line the person sent about a password, code or key: leave it out"
    p = private_part(text)
    return f"holds {p}: write it without" if p else None


def check(s, t, args):
    """The drafts this ready adds, checked: (candidates, words for the worker). Refused (Fail, before
    anything changes) for a draft too long, empty, too many, or holding a secret or something private;
    a repeat is dropped. Lessons off: nothing, and --lesson is ignored."""
    space = getattr(args, "space", None) or t.get("space")
    d = read_settings()
    if not lessons_on(space, d):
        return [], ""
    given = drafts(args)
    if len(given) > MAX_PER_READY:
        raise Fail(f"At most {MAX_PER_READY} lessons a task: keep the ones that matter most, then run ready again.")
    note = " ".join(str(getattr(args, "agents_md", None) or "").split())
    items = [(x, sc, "lesson") for x, sc in given]
    if note:
        items.append((note, "repo", "agents-md"))
    if not items:
        return [], ""
    problems, said, unfit = [], [], set()
    lines = person_lines(t)
    near = near_words(lines)
    held = holds_secret([x for x, _, _ in items])
    for i, (text, scope, frm) in enumerate(items):
        n = f"Lesson {i + 1}" if frm == "lesson" else "Your --agents-md line"
        why = why_not(text, i in held, near, long_ok=frm != "lesson")
        if why and frm == "agents-md":
            unfit.add(i)  # still the task's "For AGENTS.md" line, as before lessons
            said.append(f"{n} isn't drafted as a lesson: it {why}.")
        elif why:
            problems.append(f"{n} {why}.")
    if problems:
        raise Fail("Lessons not kept, and nothing changed: " + " ".join(problems) + " Fix them (or leave them out), then run ready again.")
    keys = {x.get("key") for o in s.data["tasks"] for x in o.get("lessons") or [] if x.get("state") == "pending"}
    gone = dropped_keys(s)  # step 3: one the person dropped is never asked again
    kept = {key_of(x["text"]) for x in kept_lessons(d, space)} | {x["key"] for x in kept_lessons(d, space) if x.get("key")}
    md = None
    out, seq = [], len(t.get("lessons") or [])
    for i, (text, scope, frm) in enumerate(items):
        if i in unfit:
            continue
        k = key_of(text)
        if k in keys:
            said.append(f"\"{text[:60]}\" is already drafted: dropped.")
            continue
        if k in kept:
            said.append(f"\"{text[:60]}\" is already kept: dropped.")
            continue
        if k in gone:
            said.append(f"\"{text[:60]}\" was dropped by the person before: dropped.")
            continue
        if scope == "repo":
            md = agents_md_keys(s.loc["folder"]) if md is None else md
            if k in md:
                said.append(f"\"{text[:60]}\" is already in AGENTS.md: dropped.")
                continue
        keys.add(k)
        seq += 1
        out.append({"id": f"l-{t['id']}-{seq}", "text": tilde(text), "scope": scope, "key": k, "state": "pending", "at": now(), "from": frm})
    if out:
        said.insert(0, f"{len(out)} lesson{'s' if len(out) > 1 else ''} drafted for the person to keep, edit or drop.")
    return out, " ".join(said)


def pending(t):
    """Its drafts waiting for the person's answer (step 3: not those gone stale, EXPIRE_MS)."""
    return [x for x in t.get("lessons") or [] if isinstance(x, dict) and x.get("state") == "pending" and not stale(x)]


def count_words(t, space=None, d=None):
    """"2 lessons" for a task's news line and show: its pending drafts, "" with none or lessons off."""
    n = len(pending(t))
    if not n or not lessons_on(space or t.get("space"), d):
        return ""
    return f"{n} lesson{'s' if n > 1 else ''}"


# ---- step 3: the person's Keep, Edit or Drop (SHEP-65) ----------------------------------------
#
# The Assistant asks the person (after Accept, never on an Autopilot wake: ASSISTANT_GUIDE, taught at
# its session's start while lessons are on) and records the answer here:
#   keep <id>          a space lesson goes to the space's `lessons.kept` in settings.json, a "you" one
#                      to Everywhere's (write_lessons, as write_autopilot); a repo one is queued for the
#                      AGENTS.md notes pull request (the Assistant's route: a notes branch, pushed only
#                      on the person's yes); a Shepherdr one goes to Feedback for Shepherdr (feedback.py's
#                      from_lesson: offered, filed only on the person's yes).
#   edit <id> --text   keep it in the person's words (checked as a draft is); a kept one's words change.
#   drop <id>          never kept, never asked again (a later draft with its key is a repeat).
#   retire <id>        a kept one turned off: it stays (off: true) so it isn't drafted again.
# Pending drafts not answered in EXPIRE_MS are dropped quietly (the tick's expire_pass: state expired).
# Off: the list and the actions still work (kept lessons stay saved), but no draft is pending to ask.

EXPIRE_MS = 7 * 24 * 3600000
ROUTE_WORDS = {"space": "this space's later briefs", "you": "every space's later briefs",
               "repo": "the AGENTS.md notes pull request", "shepherdr": "Feedback for Shepherdr"}

ASSISTANT_GUIDE = (
    "Lessons (on in Settings): at ready, a worker may draft up to 3 lessons from where the person stepped into its task; "
    "nothing reaches a later brief, AGENTS.md or Shepherdr's makers until the person keeps it. When a task with drafts is "
    "done (its `done` news line says \"n lessons\": accepted by the person), vet them first: `herdr-task lessons --pending "
    "--task <ref>` lists each one's id, who reads it and its words; drop without asking (`herdr-task lessons drop <id>`) "
    "one that is wrong, a one-off, a repeat of one kept, or would change what permission prompts or question cards ask. "
    "Then, between things, ask the person about the rest in one batch with your question tool: one question per lesson "
    "(at most 4 a card, a second card for more, never more for one task), its words and who reads it in the question, "
    "options Keep, Drop and Edit. Keep: `herdr-task lessons keep <id>`. Drop: `herdr-task lessons drop <id>`. Edit: take "
    "their words, then `herdr-task lessons edit <id> --text \"<their words>\"`. Kept: a space lesson reaches that space's "
    "later briefs, a \"you\" one every space's; a repo one waits for the AGENTS.md notes pull request (add it with the "
    "other notes on its own notes branch; push and open the pull request only on the person's yes); a Shepherdr one "
    "goes to Feedback for Shepherdr (offer it as that says, file only on their yes). On an Autopilot wake never ask: the "
    "drafts wait until the person is back. Never ask about a dropped one again; drafts nobody answered in 7 days are "
    "dropped quietly. `herdr-task lessons` lists the kept ones; `herdr-task lessons retire <id>` turns one off.")
OFF_WORDS = "Lessons are off in Settings: raise no lesson cards and keep, edit or drop nothing (kept ones stay saved)."
TURNED_ON = "Lessons are now on in Settings. " + ASSISTANT_GUIDE.split(": ", 1)[1]
TURNED_OFF = "Lessons are now off in Settings: raise no lesson cards from now on (kept ones stay saved)."


def stale(x, at=None):
    return x.get("state") == "pending" and bool(x.get("at")) and (at if at is not None else now()) - x["at"] > EXPIRE_MS


def dropped_keys(s):
    """The keys of every lesson the person dropped, in every task list here (s: the list open now)."""
    from .store import read_list, store_files
    out = set()
    for p in store_files():
        if p != getattr(s, "path", None):
            for t in (read_list(p) or {}).get("tasks") or []:
                out |= {x.get("key") for x in t.get("lessons") or [] if isinstance(x, dict) and x.get("state") == "dropped"}
    for t in s.data["tasks"]:
        out |= {x.get("key") for x in t.get("lessons") or [] if isinstance(x, dict) and x.get("state") == "dropped"}
    out.discard(None)
    return out


def expire_pass(report, folder=None):
    """The tick's look: pending drafts older than EXPIRE_MS become expired, quietly (no news, no card)."""
    from .store import Store, locate, read_list, store_files
    at = now()
    for p in store_files(folder):
        d = read_list(p)
        if not d or not os.path.isdir(d.get("folder") or ""):
            continue
        if not any(stale(x, at) for t in d.get("tasks") or [] for x in t.get("lessons") or [] if isinstance(x, dict)):
            continue
        try:
            with Store(locate(d["folder"])) as s:
                n = 0
                for t in s.data["tasks"]:
                    for x in t.get("lessons") or []:
                        if isinstance(x, dict) and stale(x, at):
                            x.update(state="expired", ended_at=at)
                            n += 1
                if n:
                    s.dirty = True
                    report.setdefault("lessons_expired", []).append({"folder": d["folder"], "n": n})
        except Fail as e:  # one list it can't write: the others still go
            report.setdefault("lessons_error", []).append(f"{d['folder']}: {e}")


def kept_at(d, space):
    """(level, lessons) kept at one level: space id, or None for Everywhere's."""
    spaces = d.get("spaces") or {}
    # fork: SHEP-67: a space under its full id ("vm/sp1", the window's own file) is found as it's kept
    layer = spaces.get(space if space in spaces else bare(space)) if space else d.get("everywhere")
    part = layer.get("lessons") if isinstance(layer, dict) else None
    kept = part.get("kept") if isinstance(part, dict) else None
    return [x for x in kept or [] if isinstance(x, dict) and x.get("text")]


def all_kept(d):
    """[(space or None, lesson)] for every kept lesson in settings, Everywhere's first."""
    out = [(None, x) for x in kept_at(d, None)]
    for sid in sorted((d.get("spaces") or {})):
        out += [(sid, x) for x in kept_at(d, sid)]
    return out


def candidates(folder=None, task=None):
    """[(list path, folder, ref, task, lesson)] of the drafts on every task list here (or one folder's)."""
    from .store import read_list, store_files, parse_ref
    out = []
    want = parse_ref(task) if task else None
    for p in store_files(folder):
        d = read_list(p)
        if not d:
            continue
        prefix = d.get("prefix") or ""
        for t in d.get("tasks") or []:
            if want and (want[1] != t.get("id") or (want[0] and want[0] != prefix)):
                continue
            for x in t.get("lessons") or []:
                if isinstance(x, dict) and x.get("id"):
                    out.append((p, d.get("folder"), f"{prefix}-{t.get('id')}" if prefix else f"#{t.get('id')}", t, x))
    return out


def caller_is_worker():
    """A task's own agent (its worker or reviewer) never keeps its own lessons: only the person's answer does."""
    if os.environ.get("HERDR_BROWSER_TASK"):
        return True
    addr = os.environ.get("HC_TERMINAL_ID")
    if not addr:
        return False
    from .base import hc_json
    k = hc_json("get", addr) or {}
    labels = k.get("labels") or {}
    return bool(labels.get("herdr.task")) or labels.get("herdr.role") in ("worker", "reviewer")


def find_draft(lid, folder):
    found = [c for c in candidates(folder) if c[4]["id"] == lid]
    if not found:
        return None
    if len({c[0] for c in found}) > 1:
        raise Fail(f"{lid} is a lesson in more than one folder ({', '.join(sorted({c[1] for c in found}))}): add --folder <its folder>.")
    return found[0]


def checked_text(text, t):
    """The person's words for a lesson, checked as a draft is (Fail with why)."""
    text = " ".join(str(text or "").split())
    why = why_not(text, bool(holds_secret([text])), near_words(person_lines(t)))
    if why:
        raise Fail(f"Not kept, and nothing changed: the lesson {why}.")
    return tilde(text)


def keep_draft(lid, folder, text=None, scope=None):
    """Keep (or with text, edit and keep) a pending draft: (row, words for the Assistant)."""
    from .store import Store, locate
    c = find_draft(lid, folder)
    if not c:
        return None
    _, fold, ref, t0, x0 = c
    if x0.get("state") not in ("pending", "expired"):
        raise Fail(f"{lid} is {x0.get('state')}, not waiting for an answer: nothing changed." +
                   (" Use `herdr-task lessons edit` or `retire` on a kept one." if x0.get("state") == "kept" else ""))
    scope = scope or x0.get("scope")
    if scope not in SCOPES:
        raise Fail(f"Say who it's for: --scope {'|'.join(SCOPES)}.")
    space = t0.get("space")
    if scope == "space" and not space:
        raise Fail(f"{ref} has no space to keep {lid} in: keep it for you everywhere (--scope you), or drop it.")
    words = checked_text(text, t0) if text is not None else x0["text"]
    edited = words != x0["text"]
    key = key_of(words)
    route, said = None, ""
    if scope in ("space", "you"):
        level = space if scope == "space" else None
        entry = {"id": lid, "text": words, "key": key, "from": [ref], "kept_at": now(), "edited": edited, "seen": 0, "off": False}

        def edit(part):
            kept = [y for y in part.get("kept") or [] if isinstance(y, dict)]
            same = next((y for y in kept if y.get("id") == lid or (y.get("key") or key_of(y.get("text") or "")) == key), None)
            if same:  # the same lesson again: seen once more, never twice in the list
                same["seen"] = int(same.get("seen") or 0) + 1
                same["from"] = list(dict.fromkeys([*(same.get("from") or []), ref]))
                same["off"] = False
                return "seen"
            kept.append(entry)
            part["kept"] = kept
            return "kept"
        how = _settings.write_lessons(level, edit)
        route = f"space:{bare(space)}" if scope == "space" else "everywhere"
        said = (f"Kept for {ROUTE_WORDS[scope]}" + (f" ({bare(space)})" if scope == "space" else "") + ": tasks started from now on get it."
                if how == "kept" else f"Already kept for {ROUTE_WORDS[scope]}: counted as seen again.")
    elif scope == "repo":
        route = "agents-md"
        said = ("Queued for the AGENTS.md notes pull request: add it with the other notes on its own notes branch "
                "(\"AGENTS.md: notes from …\"); push and open the pull request only on the person's yes.")
    else:
        from .feedback import feedback_on, from_lesson
        if not feedback_on(space):
            raise Fail("Feedback offers are off in Settings: nothing goes to Shepherdr's makers. Drop it, or keep it "
                       "for you (--scope you): nothing changed.")
        fkey, state = from_lesson(words, space, ref)
        route = f"feedback:{fkey}"
        said = ({"later": f"Handed to Feedback for Shepherdr: offer it to the person now with `herdr-task feedback --key {fkey} "
                          f"\"{words[:80]}\"` and your question tool; file it only on their yes.",
                 "declined": "The person said no to filing this one before: it isn't offered again.",
                 "filed": "Already filed for Shepherdr's makers: nothing more to do."}.get(state)
                or "Feedback for Shepherdr already has this one: it's offered from there.")
    with Store(locate(fold)) as s:
        t = s.find(ref)
        x = next(y for y in t.get("lessons") or [] if y.get("id") == lid)
        x.update(state="queued" if scope == "repo" else "kept", answered_at=now(), route=route, scope=scope,
                 **({"text": words, "key": key, "edited": True} if edited else {}))
        s.dirty = True
        row = row_of(ref, fold, t, x)
    return row, said


def end_draft(lid, folder, state):
    """Drop a pending (or queued) draft: never kept, never asked again."""
    from .store import Store, locate
    c = find_draft(lid, folder)
    if not c:
        return None
    _, fold, ref, _, x0 = c
    if x0.get("state") == "kept":
        raise Fail(f"{lid} is kept: `herdr-task lessons retire {lid}` turns it off. Nothing changed.")
    with Store(locate(fold)) as s:
        t = s.find(ref)
        x = next(y for y in t.get("lessons") or [] if y.get("id") == lid)
        x.update(state=state, answered_at=now())
        s.dirty = True
        return row_of(ref, fold, t, x), "Dropped: never kept, and never asked about again."


def change_kept(lid, text=None, off=None):
    """Edit a kept lesson's words, or retire it (off), where it's kept. None when no kept one has the id."""
    d = read_settings()
    where = next(((sp, x) for sp, x in all_kept(d) if x.get("id") == lid), None)
    if not where:
        return None
    space, x0 = where
    words = None
    if text is not None:
        words = " ".join(str(text).split())
        why = why_not(words, bool(holds_secret([words])), set())
        if why:
            raise Fail(f"Not changed: the lesson {why}.")
        words = tilde(words)

    def edit(part):
        for y in part.get("kept") or []:
            if isinstance(y, dict) and y.get("id") == lid:
                if words is not None:
                    y.update(text=words, key=key_of(words), edited=True)
                if off is not None:
                    y["off"] = bool(off)
                return dict(y)
    y = _settings.write_lessons(space, edit)
    where_words = f"in {space}" if space else "everywhere"
    said = (f"Retired {where_words}: no later brief gets it, and it isn't drafted again." if off
            else f"Changed {where_words}: tasks started from now on get the new words.")
    return {"id": lid, "space": space, "state": "retired" if y.get("off") else "kept", "text": y["text"],
            "from": y.get("from") or [], "kept_at": y.get("kept_at"), "seen": y.get("seen") or 0}, said


def row_of(ref, folder, t, x):
    state = "expired" if stale(x) else x.get("state")
    return {"id": x["id"], "task": ref, "folder": folder, "space": t.get("space"), "scope": x.get("scope"),
            "who": SCOPE_WORDS.get(x.get("scope"), x.get("scope")), "text": x.get("text"), "state": state,
            "at": x.get("at"), **({"route": x["route"]} if x.get("route") else {})}


def cmd_lessons(args):
    """herdr-task lessons [on|off|inherit] [--space ID]: the switch; lessons keep|edit|drop|retire <id>
    [--text] [--scope]: the person's answer; no word: the drafts and kept lessons (--pending: only the
    drafts waiting for an answer), and whether the switch is on."""
    from .output import say
    space = getattr(args, "space", None)
    what = getattr(args, "what", None)
    lid = getattr(args, "lesson_id", None)
    folder = getattr(args, "folder", None)
    if what in ("on", "off"):
        write_on(space, what == "on")
    elif what == "inherit":
        if not space:
            raise Fail("Only a space follows Everywhere: herdr-task lessons inherit --space <id>.")
        write_on(space, None)
    elif what in ("keep", "edit", "drop", "retire"):
        if not lid:
            raise Fail(f"Say which lesson: herdr-task lessons {what} <id> (herdr-task lessons --pending lists them).")
        if caller_is_worker():
            raise Fail("Only the person keeps, edits or drops a lesson (their Assistant asks them): a task's own agent never does.")
        text = getattr(args, "text", None)
        if what == "edit" and text is None:
            raise Fail(f"Give the new words: herdr-task lessons edit {lid} --text \"<one short rule>\".")
        if what == "retire" and text is not None:
            raise Fail("Retire takes no --text: edit it, or retire it.")
        got = None
        if what in ("edit", "retire"):  # a kept one first (its draft is answered), else a draft
            got = change_kept(lid, text=text if what == "edit" else None, off=True if what == "retire" else None)
        if got is None and what in ("keep", "edit"):
            got = keep_draft(lid, folder, text, getattr(args, "scope", None))
        elif got is None and what == "drop":
            got = end_draft(lid, folder, "dropped")
        if got is None:
            raise Fail(f"No lesson {lid} here" + (f" in {folder}" if folder else "") + ": herdr-task lessons lists them.")
        row, words = got
        return say(args, {**row, "done": what}, words)
    on = lessons_on(space)
    if what in ("on", "off", "inherit"):
        where = f"in {space}" if space else "everywhere"
        text = (f"Lessons are {'on' if on else 'off'} {where}: " +
                ("workers draft lessons at ready from where you stepped in; nothing changes a brief until you keep one."
                 if on else "workers draft none and briefs carry none; kept lessons stay saved for when it's on again."))
        return say(args, {"on": on, "space": space}, text)
    d = read_settings()
    rows = [row_of(ref, fold, t, x) for _, fold, ref, t, x in candidates(folder, getattr(args, "task", None))
            if not space or bare(t.get("space")) == bare(space)]
    waiting = [r for r in rows if r["state"] == "pending" and lessons_on(r["space"], d)]
    kept = [{"id": x["id"], "space": sp, "state": "retired" if x.get("off") else "kept", "text": x["text"],
             "from": x.get("from") or [], "kept_at": x.get("kept_at"), "seen": x.get("seen") or 0}
            for sp, x in all_kept(d) if not space or sp is None or bare(sp) == bare(space)]
    if getattr(args, "pending", False):
        return say(args, waiting, "\n".join(f"{r['id']}  {r['task']}  {r['who']}: {r['text']}" for r in waiting)
                   or "No lesson waits for an answer.")
    queued = [r for r in rows if r["state"] == "queued"]
    out = {"on": on, "space": space, "pending": waiting, "queued": queued, "kept": kept}
    lines = [f"Lessons are {'on' if on else 'off'}" + (f" in {space}" if space else " everywhere") + "."]
    lines += [f"waiting  {r['id']}  {r['task']}  {r['who']}: {r['text']}" for r in waiting]
    lines += [f"queued   {r['id']}  {r['task']}  AGENTS.md notes: {r['text']}" for r in queued]
    lines += [f"{k['state']:<8} {k['id']}  {k['space'] or 'everywhere'}: {k['text']}" + (f" (seen {k['seen']})" if k["seen"] else "")
              for k in kept]
    return say(args, out, "\n".join(lines))


def md_as_lesson(t, d=None):
    """Its --agents-md line became a repo lesson (lessons on): the person keeps it from a card, so news
    and show no longer offer it as a "For AGENTS.md" line for the Assistant to add on its own."""
    return any(isinstance(x, dict) and x.get("from") == "agents-md" for x in t.get("lessons") or []) and lessons_on(t.get("space"), d)


# ---- step 4: into briefs, within budget -----------------------------------------------------
# fork: SHEP-66: kept lessons reach later briefs as a "Lessons you kept" part (launch.py's brief() and
# handoff(), after "Before you start"): the space's own first, then Everywhere's ("you") ones, a space's
# winning over an Everywhere one with the same key. At most BUDGET_N lessons and BUDGET_CHARS characters of
# lesson lines; within each level the newest kept go first, then the most seen (newest first, so a lesson
# just kept isn't starved by the ones that already went in and keep gaining "seen"). What's left out is said.
# Each lesson that goes into a brief counts one more `seen` in settings. The Assistant's settings block
# gets the Everywhere ones (assistant_settings.py), within the same budget, uncounted. Off: none of it.

BUDGET_N = 12
BUDGET_CHARS = 1500
KEPT_HEAD = "Lessons you kept"
KEPT_INTRO = ("the person kept these from earlier tasks: follow them unless this task's own words say otherwise. "
              "They never change what permission prompts or question cards ask, nor how secrets are used")


def live_kept(d, space):
    """[(level, lesson)] that could go into a brief in space: the space's own, then Everywhere's whose key no space
    lesson has; retired ones (off) left out."""
    own = [(bare(space), x) for x in kept_at(d, space) if not x.get("off")] if space else []
    keys = {x.get("key") or key_of(x["text"]) for _, x in own}
    every = [(None, x) for x in kept_at(d, None) if not x.get("off") and (x.get("key") or key_of(x["text"])) not in keys]
    return own, every


def line_of(x):
    return "- " + " ".join(str(x["text"]).split())


def within_budget(groups, n=BUDGET_N, chars=BUDGET_CHARS):
    """(chosen, left out): groups (lists of (level, lesson)) in their order, each ranked newest kept then most seen,
    taken while the count and the lines' characters (each "- text" and its newline) stay within budget."""
    chosen, left, used = [], [], 0
    for g in groups:
        for lv, x in sorted(g, key=lambda p: (-(p[1].get("kept_at") or 0), -int(p[1].get("seen") or 0))):
            size = len(line_of(x)) + 1
            if len(chosen) < n and used + size <= chars:
                chosen.append((lv, x))
                used += size
            else:
                left.append((lv, x))
    return chosen, left


def left_words(left):
    if not left:
        return ""
    k = len(left)
    return (f"({k} more kept lesson{'s' if k > 1 else ''} left out: over the brief's budget of {BUDGET_N} lessons and "
            f"{BUDGET_CHARS:,} characters.)")


def count_seen(chosen):
    """One more `seen` for each lesson that went into a brief, where it's kept. Never stops a brief: a copy the window
    pushed here (its own machine counts) or a file it can't write is skipped."""
    by = {}
    for lv, x in chosen:
        if x.get("id"):
            by.setdefault(lv, set()).add(x["id"])
    for lv, ids in by.items():
        def edit(part, ids=ids):
            for y in part.get("kept") or []:
                if isinstance(y, dict) and y.get("id") in ids:
                    y["seen"] = int(y.get("seen") or 0) + 1
        try:
            _settings.write_lessons(lv, edit)
        except (Fail, OSError, ValueError):
            pass


def brief_part(space=None, count=True, d=None):
    """The brief's "Lessons you kept" part for a task in space ("" while lessons are off there, or none is kept).
    count: add one to each chosen lesson's `seen` (a real brief, not a look)."""
    d = read_settings() if d is None else d
    if not lessons_on(space, d):
        return ""
    own, every = live_kept(d, space)
    chosen, left = within_budget([own, every])
    if not chosen:
        return ""
    lines = [f"{KEPT_HEAD} ({KEPT_INTRO}):"]
    mine = [x for lv, x in chosen if lv is not None]
    yours = [x for lv, x in chosen if lv is None]
    if mine:
        lines.append(f"In this space ({bare(space)}):")
        lines += [line_of(x) for x in mine]
    if yours:
        lines.append("You, every space:")
        lines += [line_of(x) for x in yours]
    if left:
        lines.append(left_words(left))
    if count:
        count_seen(chosen)
    return "\n".join(lines)


def assistant_lessons(d, space=None):
    """(lines, left out) of the person's Everywhere lessons for the Assistant's settings block (lessons on there)."""
    if not lessons_on(space, d):
        return [], []
    chosen, left = within_budget([[(None, x) for x in kept_at(d, None) if not x.get("off")]])
    return [line_of(x) for _, x in chosen], left
