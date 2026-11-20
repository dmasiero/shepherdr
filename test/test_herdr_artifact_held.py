"""SHEP-72: a Mark up note (herdr-artifact note) to an agent with a dialog open is never typed into that dialog and
never lost: hc send refuses it ("blocked"), so it's held in herdr-task's held messages (its _hold, news.hold) and
herdr-task's held_pass delivers it, once, when hc takes it again. Another refusal comes back as hc's plain message.
A fake hc on PATH plays the agent; herdr-task's _hold runs for real on a throwaway task store."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from unittest import mock

import test_herdr_artifact as T

A, ROOT = T.A, T.ROOT

BIN = os.path.join(ROOT, "mods", "tasks", "bin")

# The agent t9: `hc send` refuses while $STATE/blocked exists (hc's own JSON, as hc 0.x writes it), else logs it.
HC = r"""#!/bin/sh
S="$FAKE_HC_STATE"
echo "$*" >> "$S/calls"
case "$1" in
  send)
    if [ -f "$S/blocked" ]; then
      echo '{"error":{"hint":"typing would answer its dialog; read its screen first (hc read t9), or --force","kind":"blocked","message":"t9 is blocked (question)"}}' >&2
      exit 1
    fi
    if [ -f "$S/broken" ]; then
      echo '{"error":{"kind":"gone","message":"t9 has ended"}}' >&2
      exit 1
    fi
    printf '%s\n----\n' "$3" >> "$S/sent"
    ;;
  ls) echo '[{"address":"t9","state":"live"}]' ;;
  get) echo '{"address":"t9","state":"live","labels":{}}' ;;
  *) ;;
esac
exit 0
"""


class NoteToABlockedAgent(unittest.TestCase):
    ns, publish, only = T.Artifacts.ns, T.Artifacts.publish, T.Artifacts.only

    def setUp(self):
        T.Artifacts.setUp(self)
        self.state = os.path.join(self.dir, "hc")
        self.tasks = os.path.join(self.dir, "tasks")
        fake = os.path.join(self.dir, "bin")
        for d in (self.state, self.tasks, fake):
            os.makedirs(d)
        with open(os.path.join(fake, "hc"), "w") as f:
            f.write(HC)
        os.chmod(os.path.join(fake, "hc"), 0o755)
        self.env = mock.patch.dict(os.environ, {"FAKE_HC_STATE": self.state, "HERDR_TASK_STORE": self.tasks,
                                                "PATH": fake + os.pathsep + os.environ["PATH"]})
        self.env.start()
        d = os.path.join(self.dir, "plan")
        os.makedirs(d)
        with open(os.path.join(d, "recipe.json"), "w") as f:
            json.dump({"recipe": 1, "blocks": [{"type": "text", "md": "Post it"}]}, f)
        self.publish(d, title="Posting plan")
        self.aid = self.only()[0]["id"]

    def tearDown(self):
        self.env.stop()
        T.Artifacts.tearDown(self)

    def note(self, text, json_out=True):
        o = types.SimpleNamespace(id=self.aid, text=text, version=None, spot="the top left", image=None, shot=None,
                                  panel=None, area=None, machine=None, json=json_out)
        with mock.patch("sys.stdout") as out:
            A.cmd_note(o)
        return "".join(c.args[0] for c in out.write.call_args_list)

    def sent(self):
        try:
            with open(os.path.join(self.state, "sent")) as f:
                return f.read()
        except OSError:
            return ""

    def held_pass(self):
        """herdr-task's scheduler round for held messages, on the throwaway store (hc's guard off: the fake is hc)."""
        sys.path.insert(0, BIN)
        try:
            import herdr_task.base as base
            import herdr_task.news as news
        finally:
            sys.path.remove(BIN)
        report = {}
        with mock.patch.object(base, "not_real", return_value=None), \
                mock.patch.object(news, "HELD", os.path.join(self.tasks, ".held.json")):
            news.held_pass(report)
        return report

    def held(self):
        try:
            with open(os.path.join(self.tasks, ".held.json")) as f:
                return json.load(f)
        except OSError:
            return {}

    def test_held_while_blocked_then_delivered_once_in_order(self):
        open(os.path.join(self.state, "blocked"), "w").close()
        out = json.loads(self.note("Wrong leave empty").strip().splitlines()[-1])
        self.assertEqual(out["held"], "question")
        self.assertEqual(out["to"], "t9")
        self.assertEqual(self.sent(), "")  # nothing went through hc send
        self.assertIn("It's waiting on a question", self.note("Second note", json_out=False))
        texts = [x["text"] for x in self.held()["t9"]]
        self.assertEqual(len(texts), 2)
        self.assertIn("Wrong leave empty", texts[0])
        self.assertIn("Second note", texts[1])
        self.assertTrue(all(x["how"] == "send" for x in self.held()["t9"]))
        # still blocked: the scheduler's round keeps them, sends nothing
        self.held_pass()
        self.assertEqual(self.sent(), "")
        self.assertEqual(len(self.held()["t9"]), 2)
        # the question answered: delivered, in order, then gone
        os.remove(os.path.join(self.state, "blocked"))
        report = self.held_pass()
        self.assertEqual(report.get("held"), [{"to": "t9", "messages": 2}])
        sent = self.sent()
        self.assertEqual(sent.count("----"), 1)
        self.assertLess(sent.index("Wrong leave empty"), sent.index("Second note"))
        self.assertIn('<hc from="artifact"', sent)
        self.assertEqual(self.held(), {})
        self.held_pass()
        self.assertEqual(self.sent(), sent)  # once
        with open(os.path.join(self.state, "calls")) as f:
            calls = f.read()
        self.assertNotIn("--force", calls)

    def test_a_note_to_a_free_agent_goes_at_once(self):
        out = json.loads(self.note("Looks right").strip().splitlines()[-1])
        self.assertNotIn("held", out)
        self.assertIn("Looks right", self.sent())
        self.assertEqual(self.held(), {})

    def test_another_refusal_is_its_plain_message(self):
        open(os.path.join(self.state, "broken"), "w").close()
        with self.assertRaises(A.Fail) as e:
            self.note("Hello")
        self.assertEqual(str(e.exception), "t9 has ended")
        self.assertEqual(self.held(), {})

    def test_hold_unavailable_is_said_never_lost_silently(self):
        open(os.path.join(self.state, "blocked"), "w").close()
        with mock.patch.object(A, "herdr_task", return_value=None), self.assertRaises(A.Fail) as e:
            self.note("Hello")
        self.assertEqual(str(e.exception), "t9 is blocked (question)")

    def test_hc_refusal_reads_hcs_json(self):
        r = types.SimpleNamespace(returncode=1, stdout="", stderr='{"error":{"kind":"blocked","message":"t1 is blocked (question)","hint":"x"}}')
        self.assertEqual(A.hc_refusal(r), ("blocked", "t1 is blocked (question)"))
        self.assertEqual(A.hc_refusal(types.SimpleNamespace(returncode=1, stdout="", stderr="hc: no such terminal\n")),
                         (None, "hc: no such terminal"))


if __name__ == "__main__":
    unittest.main()
