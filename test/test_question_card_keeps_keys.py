"""A question card's "Other…" box keeps the keyboard while the person types in it (SHEP-74): the chat's refocus()
(mods/chat/main.js) gave it back to the composer on the re-render each keystroke makes once the last press was over
1.5 s old, so the keys split between the two boxes. cards.js runs whole, in node, with gpui's InputState a stand-in
whose focus moves as gpui's does (one owner; the old one hears "blur", the new one "focus"); refocus() and cardKeys()
run as written in main.js, on a chat whose composer is the same kind of stand-in, every timer at once.
SHEP74_ROOT: another tree's copy (a before-check against main)."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.environ.get("SHEP74_ROOT") or HERE
CARDS = os.path.join(ROOT, "mods", "chat", "cards.js")
SECRET = os.path.join(ROOT, "mods", "chat", "secret-card.js")
MAIN = os.path.join(ROOT, "mods", "chat", "main.js")
ASKS = os.path.join(ROOT, "mods", "chat", "core", "asks.js")

STUBS = r"""
const div = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => div()) });
// One keyboard for the window: focus() moves it, the old box hears "blur", the new one "focus".
const kb = { owner: null, cx: null };
const boxes = [];
const mkBox = (name) => {
  const on = {};
  const b = { name, val: "", released: false, value: () => b.val, set_value: (v) => { b.val = v; }, set_masked() {},
    release: () => { b.released = true; if (kb.owner === b) kb.owner = null; },
    on: (ev, f) => { (on[ev] ??= []).push(f); }, emit: (ev, e, cx) => (on[ev] ?? []).forEach((f) => f(e, cx)),
    focus: () => { if (kb.owner === b) return; const was = kb.owner; kb.owner = b; was?.emit?.("blur", {}, kb.cx); b.emit("focus", {}, kb.cx); } };
  return b;
};
const InputState = { new: () => { const b = mkBox(`card${boxes.length}`); boxes.push(b); return b; } };
"""

HARNESS = r"""
const renders = { n: 0 };
const cx = { notify() { renders.n++; }, stop_propagation() {}, timer: { after: (_ms, f) => f(cx) } };
kb.cx = cx;
const sinkFocus = { focus() { const was = kb.owner; kb.owner = "card-keys"; was?.emit?.("blur", {}, cx); } };
const host = { reply() {}, toTerminal() {}, chatAbout() {} };
// The chat: its composer, its cards, refocus() and cardKeys() as main.js has them.
const shared = () => null, dialogHolds = () => false, keysElsewhere = () => false, liveHolder = (h) => h;
const KEY_HOLDER = "keyboard.holder";
const methods = { %(methods)s };
const chat = Object.assign(Object.create(methods), { box: mkBox("composer"), wasFocused: true, hadBox: true, focused: true,
  call: null, pressMoved: false, press: { at: Date.now() - 5000 }, refocusAt: 0, areaKey: () => "pane", keepsText: () => false,
  cards: new AskCards(host, sinkFocus), workerCards: new AskCards(host, sinkFocus), codexCards: new AskCards(host, sinkFocus),
  secretCards: new SecretCards() });
chat.box.on("focus", () => { chat.focused = true; });
chat.box.on("blur", () => { chat.focused = false; });
chat.box.focus();
// A render, as draw() does it: refocus() then remember the pane's state.
const render = () => { chat.refocus(true, true, cx); chat.wasFocused = true; chat.hadBox = true; };
// A key: to whichever box has the keyboard; its "change" re-renders, as the window's does.
const type = (text) => { for (const ch of text) { const b = kb.owner; if (b?.val == null) continue; b.val += ch; b.emit("change", {}, cx); render(); } };
const ask = { id: "a1", req: { tool_input: { questions: [] } }, words: { kind: "questions",
  questions: [{ text: "Extra principal?", header: "Extra", options: [{ name: "None" }, { name: "$100" }] }] } };
const boxOf = () => chat.cards.strips(ask, {}).find((s) => s.kind === "input")?.state ?? null;
%(body)s
"""

# A press on "Other…": the card takes the keys (pressed()), then openOther() puts them in its box.
PICK_OTHER = "chat.cards.pressed(ask); chat.cards.openOther(ask, 0, cx); render();"


def method(src, name):
    m = re.search(r"\n  (%s\(.*?\) \{\n.*?\n  \})\n" % re.escape(name), src, re.S)
    return m.group(1) if m else None


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def run(body):
    cards, secret, main = (read(p) for p in (CARDS, SECRET, MAIN))
    head, _, rest = cards.partition("export class AskCards")
    imports = re.findall(r'^import .*?;\n', head, re.M)
    for line in imports:
        head = head.replace(line, "")
    src = STUBS + head.replace("export ", "") + "class AskCards" + rest
    asks = 'import { allow, deny, answer, answers, annotationsOf, chatAbout, dismiss, release } from %s;\n' % json.dumps("file://" + ASKS)
    # The secrets card: its own lines past its imports (its store isn't needed for focus).
    sc = re.sub(r'^import .*?;\n', "", secret, flags=re.M).replace("export class", "class")
    refocus = method(main, "refocus")
    card_keys = method(main, "cardKeys") or "cardKeys() { return false; }"  # main before SHEP-74 had none
    assert refocus, "main.js refocus() not found"
    script = asks + src + "\nconst secrets = {};\nconst green = () => null;\n" + sc + HARNESS % {
        "methods": refocus + ",\n" + card_keys, "body": body}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "keys.mjs")
        with open(path, "w") as f:
            f.write(script)
        out = subprocess.run(["node", path], capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr)
    return json.loads(out.stdout)


class OtherBoxKeepsTheKeyboard(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            raise unittest.SkipTest("no node")

    def test_typing_in_other_stays_in_other(self):
        # The repro: "Other…" picked, then typing well after the press (re-renders on every key).
        got = run(PICK_OTHER + """
type("1 2 3 4 5");
console.log(JSON.stringify({ other: boxOf()?.val, composer: chat.box.val, owner: kb.owner?.name ?? kb.owner }));""")
        self.assertEqual(got, {"other": "1 2 3 4 5", "composer": "", "owner": "card0"})

    def test_text_survives_re_renders_and_ask_refreshes(self):
        got = run(PICK_OTHER + """
type("one two"); const first = boxOf();
for (let i = 0; i < 5; i++) { chat.cards.keep(["a1"]); chat.cards.strips(ask, {}); render(); }
type(" three");
console.log(JSON.stringify({ same: boxOf() === first, other: boxOf()?.val, composer: chat.box.val, released: first.released }));""")
        self.assertEqual(got, {"same": True, "other": "one two three", "composer": "", "released": False})

    def test_the_pane_focused_anew_leaves_the_box_be(self):
        # refocus()'s other branch (the pane newly focused, its 0 and 600 ms timers) never takes it either.
        got = run(PICK_OTHER + """
type("ab"); chat.wasFocused = false; chat.refocus(true, true, cx); type("c");
console.log(JSON.stringify({ other: boxOf()?.val, composer: chat.box.val }));""")
        self.assertEqual(got, {"other": "abc", "composer": ""})

    def test_the_composer_gets_the_keyboard_back_once_the_box_lets_go(self):
        # Answered (the box released) or the card pressed elsewhere: the composer takes the keys again, as before.
        got = run(PICK_OTHER + """
type("x"); chat.cards.pressed(ask); const mid = chat.cardKeys(); chat.refocusAt = 0; render(); type("y");
console.log(JSON.stringify({ mid, other: boxOf()?.val, composer: chat.box.val }));""")
        self.assertEqual(got, {"mid": False, "other": "x", "composer": "y"})

    def test_a_dropped_ask_forgets_its_box(self):
        got = run(PICK_OTHER + """
type("x"); chat.cards.drop(ask);
console.log(JSON.stringify({ keys: chat.cardKeys() }));""")
        self.assertEqual(got, {"keys": False})

    def test_a_secrets_masked_box_keeps_the_keyboard_too(self):
        got = run("""
const sa = { address: "t1", name: "API_KEY", why: "x" };
chat.secretCards.prepare([sa], cx); const st = chat.secretCards.states.get("t1|API_KEY");
st.box.focus(); render(); type("s3cr3t");
console.log(JSON.stringify({ box: st.box.val, composer: chat.box.val }));""")
        self.assertEqual(got, {"box": "s3cr3t", "composer": ""})


if __name__ == "__main__":
    unittest.main()
