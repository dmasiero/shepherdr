"""fork: SHEP-64: Lessons, step 2 of 5 (designed in SHEP-62): a worker drafts up to 3 lessons at ready, from
where the person stepped into its task (touches.py), and Herdr checks them before they're kept on the task as
candidates (t["lessons"], state pending) for the person's Keep, Edit or Drop (step 3).

A candidate: {id, text, scope, key, state, at, from}: id "l-<task id>-<n>"; scope repo (the repo's AGENTS.md),
space (this space's later briefs), you (the person's, every space) or shepherdr (Shepherdr's makers: Feedback);
key: feedback.key_of(text), its words that say something; from: "lesson" (--lesson) or "agents-md" (--agents-md,
which stays the task's "For AGENTS.md" line too until step 3 keeps repo lessons itself).

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
    d = read_settings()
    if d.get("pushed_from"):
        raise Fail("This machine's Shepherdr settings are a copy from the machine whose window sets them: switch Lessons there.")
    layer = d.setdefault("spaces", {}).setdefault(bare(space), {}) if space else d.setdefault("everywhere", {})
    part = layer.get("lessons") if isinstance(layer.get("lessons"), dict) else {}
    if value is None:
        part.pop("on", None)
    else:
        part["on"] = bool(value)
    if part:
        layer["lessons"] = part
    else:
        layer.pop("lessons", None)
    if space and not layer:
        d["spaces"].pop(bare(space), None)
    d["version"] = 1
    path = _settings.SETTINGS
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def cmd_lessons(args):
    """herdr-task lessons [on|off|inherit] [--space ID]: the switch, or what it is now."""
    space = getattr(args, "space", None)
    what = getattr(args, "what", None)
    if what in ("on", "off"):
        write_on(space, what == "on")
    elif what == "inherit":
        if not space:
            raise Fail("Only a space follows Everywhere: herdr-task lessons inherit --space <id>.")
        write_on(space, None)
    on = lessons_on(space)
    where = f"in {space}" if space else "everywhere"
    text = (f"Lessons are {'on' if on else 'off'} {where}: " +
            ("workers draft lessons at ready from where you stepped in; nothing changes a brief until you keep one."
             if on else "workers draft none and briefs carry none; kept lessons stay saved for when it's on again."))
    print(json.dumps({"on": on, "space": space}) if getattr(args, "json", False) else text)


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
        why = None
        if not text:
            why = "is empty"
        elif len(text) > MAX_TEXT and frm == "lesson":
            why = f"is {len(text)} characters: one short rule, {MAX_TEXT} at most"
        elif i in held:
            why = "holds the value of a secret you can use: never put one in a lesson"
        elif SAID.search(text):
            why = "says a password, token or key in plain words: a lesson never holds one"
        elif near & {w.strip(".,;:!?()[]{}\"'`").lower() for w in TOKEN.findall(text) if secretish(w)}:
            why = "shares a word with a line the person sent about a password, code or key: leave it out"
        else:
            p = private_part(text)
            if p:
                why = f"holds {p}: write it without"
        if why and frm == "agents-md":
            unfit.add(i)  # still the task's "For AGENTS.md" line, as before lessons
            said.append(f"{n} isn't drafted as a lesson: it {why}.")
        elif why:
            problems.append(f"{n} {why}.")
    if problems:
        raise Fail("Lessons not kept, and nothing changed: " + " ".join(problems) + " Fix them (or leave them out), then run ready again.")
    keys = {x.get("key") for o in s.data["tasks"] for x in o.get("lessons") or [] if x.get("state") == "pending"}
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
    return [x for x in t.get("lessons") or [] if isinstance(x, dict) and x.get("state") == "pending"]


def count_words(t, space=None, d=None):
    """"2 lessons" for a task's news line and show: its pending drafts, "" with none or lessons off."""
    n = len(pending(t))
    if not n or not lessons_on(space or t.get("space"), d):
        return ""
    return f"{n} lesson{'s' if n > 1 else ''}"
