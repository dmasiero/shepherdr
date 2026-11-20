"""Enter in a question card's "Other…" box (mods/chat/cards.js, AskUserQuestion) does what the card's button does
(SHEP-73): one question submits once it's ready, several move to the next step and the last submits, a multi-select
keeps its ticks beside the words, an empty box or Shift+Enter sends nothing, and nothing is sent twice.
cards.js runs as it is written, in node: gpui's InputState is a stand-in whose events the test fires, the box's own
"submit" as gpui sends it for Enter; core/asks.js is the real one."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# SHEP73_CARDS: another copy of cards.js, for a before-check against main's.
CARDS = os.environ.get("SHEP73_CARDS") or os.path.join(ROOT, "mods", "chat", "cards.js")
ASKS = os.path.join(ROOT, "mods", "chat", "core", "asks.js")

STUBS = r"""
const div = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => div()) });
const boxes = [];
const InputState = { new: () => {
  const on = {};
  const b = { val: "", focused: 0, released: false, value: () => b.val, focus: () => { b.focused++; }, release: () => { b.released = true; },
    on: (name, f) => { (on[name] ??= []).push(f); }, emit: (name, e, cx) => (on[name] ?? []).forEach((f) => f(e, cx)) };
  boxes.push(b);
  return b;
} };
"""

HARNESS = r"""
const replies = [];
const host = { reply: (ask, text) => replies.push(JSON.parse(text)), toTerminal() {}, chatAbout() {} };
const focus = { n: 0, focus() { this.n++; } };
const cards = new AskCards(host, focus);
const cx = { notify() {}, stop_propagation() {}, timer: { after: (_ms, f) => f(cx) } };
const ask = (questions) => ({ id: "a1", req: { tool_input: { questions: [] } }, words: { kind: "questions", questions } });
const opt = (...names) => names.map((name) => ({ name }));
const enter = (b, shift = false) => b.emit("submit", { shift }, cx);
const sent = () => replies.map((r) => r.hookSpecificOutput?.decision?.updatedInput?.answers ?? r);
%(body)s
"""


def run(body):
    with open(CARDS, encoding="utf-8") as f:
        src = f.read()
    src = src.replace('import { div } from "gpui-kit";\n', "")
    src = src.replace('import { InputState } from "gpui-base";\n', STUBS)
    src = src.replace('"./core/asks.js"', json.dumps("file://" + ASKS))
    assert STUBS in src and "gpui-" not in src.split("export class")[0].replace(STUBS, ""), "cards.js imports changed"
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "card.mjs")
        with open(path, "w") as f:
            f.write(src + HARNESS % {"body": body})
        out = subprocess.run(["node", path], capture_output=True, text=True)
    if out.returncode:
        raise AssertionError(out.stderr)
    return json.loads(out.stdout)


ONE = 'const a = ask([{ text: "Color?", header: "Color", options: opt("Red", "Blue") }]);'
THREE = ('const a = ask([{ text: "Color?", header: "Color", options: opt("Red", "Blue") },'
         ' { text: "Size?", header: "Size", options: opt("S", "M") },'
         ' { text: "Shape?", header: "Shape", options: opt("Round", "Square") }]);')


class OtherBoxEnter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("node") is None:
            raise unittest.SkipTest("no node")

    def test_one_question_enter_submits_the_words(self):
        got = run(ONE + """
cards.openOther(a, 0, cx); boxes[0].val = "  Teal "; enter(boxes[0]);
console.log(JSON.stringify({ sent: sent(), focused: boxes[0].focused, kept: cards.states.has("a1") }));""")
        self.assertEqual(got["sent"], [{"Color?": "Teal"}])
        self.assertEqual(got["focused"], 1)  # the box had the keyboard when Enter came
        self.assertFalse(got["kept"])

    def test_an_empty_other_box_sends_nothing(self):
        got = run(ONE + """
cards.openOther(a, 0, cx); boxes[0].val = "   "; enter(boxes[0]);
console.log(JSON.stringify({ sent: sent(), step: cards.states.get("a1").step }));""")
        self.assertEqual(got, {"sent": [], "step": 0})

    def test_shift_enter_never_submits(self):
        got = run(ONE + """
cards.openOther(a, 0, cx); boxes[0].val = "Teal"; enter(boxes[0], true);
console.log(JSON.stringify({ sent: sent(), kept: cards.states.has("a1") }));""")
        self.assertEqual(got, {"sent": [], "kept": True})

    def test_a_second_enter_sends_nothing_more(self):
        got = run(ONE + """
cards.openOther(a, 0, cx); boxes[0].val = "Teal"; enter(boxes[0]); enter(boxes[0]);
console.log(JSON.stringify({ sent: sent(), released: boxes[0].released }));""")
        self.assertEqual(got, {"sent": [{"Color?": "Teal"}], "released": True})

    def test_several_questions_step_on_then_the_last_submits(self):
        got = run(THREE + """
const steps = [];
cards.openOther(a, 0, cx); boxes[0].val = "Teal"; enter(boxes[0]); steps.push(cards.state(a).step);
cards.pick(a, 1, 1); steps.push(cards.state(a).step);
cards.openOther(a, 2, cx); boxes[1].val = "Oval"; const before = sent().length; enter(boxes[1]);
console.log(JSON.stringify({ steps, before, sent: sent(), keys: focus.n, keyed: cards.keyed }));""")
        self.assertEqual(got["steps"], [1, 2])
        self.assertEqual(got["before"], 0)
        self.assertEqual(got["sent"], [{"Color?": "Teal", "Size?": "M", "Shape?": "Oval"}])
        self.assertEqual(got["keys"], 1)  # the card took the keys when its box went with step 1
        self.assertIsNone(got["keyed"])

    def test_the_last_step_with_one_missing_shows_the_answers_to_check(self):
        got = run(THREE + """
cards.go(a, 2); cards.openOther(a, 2, cx); boxes[0].val = "Oval"; enter(boxes[0]);
console.log(JSON.stringify({ sent: sent(), step: cards.state(a).step }));""")
        self.assertEqual(got, {"sent": [], "step": 3})

    def test_an_empty_box_on_the_last_step_stays(self):
        got = run(THREE + """
cards.go(a, 2); cards.openOther(a, 2, cx); enter(boxes[0]);
console.log(JSON.stringify({ sent: sent(), step: cards.state(a).step }));""")
        self.assertEqual(got, {"sent": [], "step": 2})

    def test_multi_select_keeps_its_ticks_beside_the_words(self):
        got = run("""const a = ask([{ text: "Toppings?", header: "Top", multi: true, options: opt("Ham", "Egg", "Leek") }]);
cards.pick(a, 0, 2); cards.pick(a, 0, 0); cards.openOther(a, 0, cx); boxes[0].val = "Chili"; enter(boxes[0]);
console.log(JSON.stringify({ sent: sent() }));""")
        self.assertEqual(got["sent"], [{"Toppings?": "Ham, Leek, Chili"}])

    def test_multi_select_steps_on_too(self):
        got = run("""const a = ask([{ text: "Toppings?", header: "Top", multi: true, options: opt("Ham", "Egg") },
 { text: "Size?", header: "Size", options: opt("S", "M") }]);
cards.pick(a, 0, 1); cards.openOther(a, 0, cx); boxes[0].val = "Chili"; enter(boxes[0]);
const step = cards.state(a).step; cards.pick(a, 1, 0); cards.submit(a, cx);
console.log(JSON.stringify({ step, sent: sent() }));""")
        self.assertEqual(got["step"], 1)
        self.assertEqual(got["sent"], [{"Toppings?": "Egg, Chili", "Size?": "S"}])

    def test_the_submit_button_gives_the_same_answer(self):
        # Enter and a click on Submit send one answer, the same.
        got = run(ONE + """
cards.openOther(a, 0, cx); boxes[0].val = "Teal";
const strips = cards.strips(a, {}); const btn = strips.find((s) => s.key === "submit").ctls[0];
btn.fn(cx); console.log(JSON.stringify({ disabled: btn.disabled, sent: sent() }));""")
        self.assertEqual(got, {"disabled": False, "sent": [{"Color?": "Teal"}]})


if __name__ == "__main__":
    unittest.main()
