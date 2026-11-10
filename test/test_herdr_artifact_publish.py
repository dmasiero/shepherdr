"""herdr-artifact publish against a fake herdr-app (first on PATH): a read-only install (Nix) still publishes (#749),
a checker that doesn't connect or hangs doesn't stop a recipe (#847, #843), and a publish waiting on another one's lock
says so (#843). Runs in a throwaway store; nothing is installed."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import fcntl
import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.dont_write_bytecode = True


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


A = load("herdr_artifact_publish_under_test", os.path.join(ROOT, "mods", "artifacts", "bin", "herdr-artifact"))

# A stand-in herdr-app: `check <dir> --print-spec` does what $FAKE_CHECK says, and logs each call.
FAKE = """#!/bin/sh
echo "$@" >> "$FAKE_LOG"
case "$FAKE_CHECK" in
  ok) echo 'div'; exit 0 ;;
  noconnect) echo 'herdr-app: isolated checker failed: checker job did not connect within 10 seconds' >&2; exit 1 ;;
  hang) sleep 30 & wait ;;
  broken) echo 'TypeError: blocks is not iterable' >&2; exit 1 ;;
esac
"""


class Publish(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="shepherdr-artifact-")
        store = os.path.join(self.dir, "store")
        self.folder = os.path.join(self.dir, "proj")
        os.makedirs(self.folder)
        bin_ = os.path.join(self.dir, "bin")
        os.makedirs(bin_)
        with open(os.path.join(bin_, "herdr-app"), "w") as f:
            f.write(FAKE)
        os.chmod(os.path.join(bin_, "herdr-app"), 0o755)
        self.log = os.path.join(self.dir, "calls")
        self.patches = [mock.patch.object(A, "STORE", store), mock.patch.object(A, "FILES", os.path.join(store, "files")),
                        mock.patch.object(A, "NOTES", os.path.join(store, "notes")),
                        mock.patch.object(A, "APP", os.path.join(self.dir, "app")),
                        mock.patch.object(A, "me", return_value={"terminal": "t9", "task": None}),
                        mock.patch.dict(os.environ, {"PATH": bin_ + os.pathsep + os.environ.get("PATH", ""),
                                                     "FAKE_LOG": self.log, "FAKE_CHECK": "ok"})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        for root, dirs, _ in os.walk(self.dir):
            for d in dirs:
                os.chmod(os.path.join(root, d), 0o755)
        shutil.rmtree(self.dir, ignore_errors=True)

    def recipe(self, name="proof"):
        d = os.path.join(self.dir, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "recipe.json"), "w") as f:
            json.dump({"recipe": 1, "blocks": [{"type": "text", "text": "It works."}]}, f)
        return d

    def publish(self, d, **k):
        base = dict(id=None, title="Report", folder=self.folder, task=None, note=None, json=True, custom=False, dir=d)
        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            A.cmd_publish(types.SimpleNamespace(**{**base, **k}))
        return json.loads(out.getvalue())

    def calls(self):
        try:
            with open(self.log) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def test_a_read_only_install_publishes(self):
        """#749: the installed recipe view, its core and Mark up are read-only (a Nix store): staging still rewrites them."""
        ro = os.path.join(self.dir, "nix-store")
        os.makedirs(ro)
        parts = {}
        for name, src in (("RECIPE_VIEW", A.RECIPE_VIEW), ("RECIPE_CORE", A.RECIPE_CORE), ("MARKUP", A.MARKUP)):
            dst = os.path.join(ro, name + ".js")
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o444)
            parts[name] = dst
        marks = []
        for i, (src, installed, rename) in enumerate(A.MARKUP_PARTS):
            dst = os.path.join(ro, f"markup-part-{i}.js")
            shutil.copyfile(src, dst)
            os.chmod(dst, 0o444)
            marks.append((dst, installed, rename))
        parts["MARKUP_PARTS"] = marks
        os.chmod(ro, 0o555)
        d = self.recipe()
        os.chmod(os.path.join(d, "recipe.json"), 0o444)
        os.makedirs(os.path.join(self.dir, "app", "mods"))
        with mock.patch.multiple(A, **parts):
            out = self.publish(d)
        self.assertTrue(out["installed"])
        self.assertEqual(len(self.calls()), 2)  # dark and light
        mod = os.path.join(self.dir, "app", "mods", out["mod"])
        for f in ("recipe-view.js", "recipe.js", "artifact-markup.js", "artifact-dirs.js", "artifact-paths.js", "recipe.json"):
            self.assertTrue(os.stat(os.path.join(mod, f)).st_mode & stat.S_IWUSR, f)

    def imports_resolve(self, mod):
        """Every relative import in an installed mod names a file that's there (as the window loads it)."""
        rel = re.compile(r'''(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}/[^"']+)["']''')
        seen = 0
        for d, _, files in os.walk(mod):
            for f in files:
                if f.endswith(".js"):
                    with open(os.path.join(d, f), encoding="utf-8") as fh:
                        for spec in rel.findall(fh.read()):
                            seen += 1
                            target = os.path.normpath(os.path.join(d, spec))
                            self.assertTrue(target.startswith(mod + os.sep) and os.path.isfile(target),
                                            f"{f}: {spec} isn't in the installed mod")
        return seen

    def test_an_installed_recipe_has_everything_it_imports(self):
        """SHEP-36: Mark up imported ./dirs.js (and it ./core/paths.js), never copied in: every artifact failed to
        load in the window. Each import of an installed mod resolves there, under names of ours."""
        os.makedirs(os.path.join(self.dir, "app", "mods"))
        out = self.publish(self.recipe())
        mod = os.path.join(self.dir, "app", "mods", out["mod"])
        self.assertGreater(self.imports_resolve(mod), 3)
        for f in ("artifact-markup.js", "artifact-dirs.js", "artifact-paths.js"):
            self.assertTrue(os.path.isfile(os.path.join(mod, f)), f)
        with open(os.path.join(mod, "artifact-markup.js")) as f:
            self.assertIn('from "./artifact-dirs.js"', f.read())
        with open(os.path.join(mod, ".version")) as f:
            self.assertEqual(f.read().split(), ["1", A.markup_hash()])

    def test_a_custom_panel_has_everything_it_imports(self):
        """The same for a custom panel, whose own dirs.js and core/ can't collide with Mark up's."""
        os.makedirs(os.path.join(self.dir, "app", "mods"))
        d = os.path.join(self.dir, "panel")
        os.makedirs(os.path.join(d, "core"))
        with open(os.path.join(d, "main.js"), "w") as f:
            f.write('import { mine } from "./dirs.js";\nexport default class X {}\n')
        with open(os.path.join(d, "dirs.js"), "w") as f:
            f.write('import { p } from "./core/paths.js";\nexport const mine = p;\n')
        with open(os.path.join(d, "core", "paths.js"), "w") as f:
            f.write('export const p = 1;\n')
        out = self.publish(d, custom=True)
        mod = os.path.join(self.dir, "app", "mods", out["mod"])
        self.imports_resolve(mod)
        with open(os.path.join(mod, "dirs.js")) as f:
            self.assertIn("export const mine", f.read())  # its own, untouched
        with open(os.path.join(mod, "core", "paths.js")) as f:
            self.assertEqual(f.read(), "export const p = 1;\n")

    def test_a_broken_install_heals(self):
        """An artifact installed with the old Mark up (its .version names the old hash) is no longer current, so its
        next open reinstalls it; the hash follows every copied part, not markup.js alone."""
        os.makedirs(os.path.join(self.dir, "app", "mods"))
        out = self.publish(self.recipe())
        mod = out["mod"]
        self.assertTrue(A.current(mod, 1))
        with open(os.path.join(self.dir, "app", "mods", mod, ".version"), "w") as f:
            f.write("1 bf40b2b9d7f6\n")  # what the broken (SHEP-141) installs carry
        self.assertFalse(A.current(mod, 1))
        os.remove(os.path.join(self.dir, "app", "mods", mod, "artifact-dirs.js"))
        A.local_mod(out["id"])
        self.assertTrue(A.current(mod, 1))
        self.imports_resolve(os.path.join(self.dir, "app", "mods", mod))
        # a change to dirs.js alone changes the hash
        alt = os.path.join(self.dir, "dirs-changed.js")
        with open(A.MARKUP_PARTS[1][0]) as f, open(alt, "w") as g:
            g.write(f.read() + "\n// changed\n")
        parts = [A.MARKUP_PARTS[0], (alt,) + tuple(A.MARKUP_PARTS[1][1:]), A.MARKUP_PARTS[2]]
        with mock.patch.object(A, "MARKUP_PARTS", parts):
            self.assertFalse(A.current(mod, 1))

    def test_markup_importing_what_is_not_copied_lays_no_markup(self):
        """A Mark up that imports something not copied in isn't laid over (the artifact still loads, unwrapped)."""
        bad = os.path.join(self.dir, "markup-bad.js")
        with open(A.MARKUP) as f, open(bad, "w") as g:
            g.write('import { x } from "./elsewhere.js";\n' + f.read())
        with mock.patch.object(A, "MARKUP_PARTS", [(bad,) + tuple(A.MARKUP_PARTS[0][1:])] + A.MARKUP_PARTS[1:]):
            self.assertIsNone(A.markup_files())
            self.assertEqual(A.markup_hash(), "")

    def test_a_checker_that_does_not_connect_still_publishes_a_recipe(self):
        """#847: herdr-app's isolated checker doesn't connect (after Herdr restarted): it tries again, then a recipe
        (already checked against its schema) publishes, saying it wasn't drawn."""
        os.environ["FAKE_CHECK"] = "noconnect"
        with mock.patch.object(A, "RETRY_WAIT", 0):
            out = self.publish(self.recipe())
        self.assertEqual(out["version"], 1)
        self.assertIn("did not connect", out["unchecked"])
        self.assertEqual(len(self.calls()), 2)  # tried twice, then not again for light

    def test_a_custom_panel_still_needs_the_check(self):
        """#847: a custom panel isn't published undrawn: it says Herdr couldn't check it, and to try again."""
        os.environ["FAKE_CHECK"] = "noconnect"
        d = os.path.join(self.dir, "panel")
        os.makedirs(d)
        with open(os.path.join(d, "main.js"), "w") as f:
            f.write('export default class X {}\n')
        with mock.patch.object(A, "RETRY_WAIT", 0), self.assertRaises(A.Fail) as e:
            self.publish(d, custom=True)
        self.assertIn("couldn't draw it", str(e.exception))
        with A.Store(A.locate(self.folder), write=False) as st:
            self.assertEqual(st.data["artifacts"], [])

    def test_a_broken_recipe_is_still_refused(self):
        """A real failure to draw isn't taken for the checker's own trouble."""
        os.environ["FAKE_CHECK"] = "broken"
        with self.assertRaises(A.Fail) as e:
            self.publish(self.recipe())
        self.assertIn("not iterable", str(e.exception))
        self.assertEqual(len(self.calls()), 1)

    def test_a_hanging_checker_times_out(self):
        """#843: a check that never ends (its checker waits forever) gives up, and the recipe publishes."""
        os.environ["FAKE_CHECK"] = "hang"
        t = time.time()
        with mock.patch.object(A, "CHECK_TIMEOUT", 0.5), mock.patch.object(A, "RETRY_WAIT", 0):
            out = self.publish(self.recipe())
        self.assertLess(time.time() - t, 10)
        self.assertIn("didn't finish", out["unchecked"])

    def test_every_installed_import_resolves(self):
        """#870: the installed Mark up imports dirs.js (and that imports core/paths.js), which the artifact's mod
        must carry: a relative import with no file beside it fails the whole artifact in the desktop app."""
        pat = re.compile(r"""(?:^|[\s;}])(?:import|export)\b[^'"`;]*?(?:from\s*)?['"](\.{1,2}/[^'"]+)['"]|import\s*\(\s*['"](\.{1,2}/[^'"]+)['"]""", re.M)
        os.makedirs(os.path.join(self.dir, "app", "mods"))
        for kind, d in (("recipe", self.recipe()), ("custom panel", self.panel())):
            with self.subTest(kind=kind):
                out = self.publish(d, custom=kind == "custom panel")
                mod = os.path.join(self.dir, "app", "mods", out["mod"])
                js = [os.path.join(r, n) for r, _, names in os.walk(mod) for n in names if n.endswith(".js")]
                self.assertIn("artifact-markup.js", [os.path.basename(f) for f in js])
                missing = []
                for f in js:
                    with open(f) as fh:
                        for m in pat.finditer(fh.read()):
                            target = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1) or m.group(2)))
                            if not os.path.isfile(target):
                                missing.append(f"{os.path.relpath(f, mod)} imports {m.group(1) or m.group(2)}")
                self.assertEqual(missing, [])

    def panel(self):
        d = os.path.join(self.dir, "panel")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "main.js"), "w") as f:
            f.write('export default class X {}\n')
        return d

    def test_waiting_on_another_publish_says_so(self):
        """#843: another publish in the same folder holds its list: this one says what it waits on, then goes on."""
        d = self.recipe()
        with A.Store(A.locate(self.folder)) as s:
            lock = os.path.join(A.STORE, "." + os.path.basename(s.path) + ".lock")
        held = open(lock, "a")
        fcntl.flock(held, fcntl.LOCK_EX)
        threading.Timer(0.5, lambda: (fcntl.flock(held, fcntl.LOCK_UN), held.close())).start()
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            out = self.publish(d)
        self.assertEqual(out["version"], 1)
        self.assertIn("Waiting for another herdr-artifact", err.getvalue())


if __name__ == "__main__":
    unittest.main()
