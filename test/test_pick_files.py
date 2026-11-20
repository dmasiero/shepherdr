"""The chat's attach button on Linux (mods/chat/pick-files.py, SHEP-75). It spoke D-Bus through PyGObject (gi), which
NixOS's python3 lacks, so the button only said "Couldn't open the file picker.". It now speaks D-Bus itself (standard
library only) and says why when no picker can open.

Each test runs the script as the chat does (`python3 -I`, here also `-S`: no site-packages at all, so no gi) against a
private dbus-daemon with no service activation, in a clean environment (no WAYLAND_DISPLAY), so no real portal or
dialog can ever start. The portal is a fake that uses the script's own D-Bus code: it answers OpenFile, then sends
Request.Response as the real one does after the person picks."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "mods", "chat", "pick-files.py")

CONFIG = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=%s</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"""

def load():
    spec = importlib.util.spec_from_file_location("pick_files", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(shutil.which("dbus-daemon"), "no dbus-daemon")
class PickFiles(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="pick-files-")
        sock = os.path.join(self.dir, "bus")
        with open(os.path.join(self.dir, "bus.conf"), "w") as f:
            f.write(CONFIG % sock)
        self.daemon = subprocess.Popen(["dbus-daemon", "--nofork", "--config-file", os.path.join(self.dir, "bus.conf")],
                                       env=self.env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.path.exists(sock):
                break
            time.sleep(0.02)
        self.address = f"unix:path={sock}"
        self.portal = None

    def tearDown(self):
        if self.portal:
            self.portal.stdout.close()
        for p in (self.portal, self.daemon):
            if p and p.poll() is None:
                p.kill()
                p.wait()
        shutil.rmtree(self.dir, ignore_errors=True)

    def env(self, **extra):
        return {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ["HOME"], **extra}

    def fake_portal(self, mode):
        self.portal = subprocess.Popen([sys.executable, "-I", os.path.join(ROOT, "test", "fake_portal.py"), SCRIPT, mode],
                                       env=self.env(DBUS_SESSION_BUS_ADDRESS=self.address),
                                       stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.portal.stdout.readline().strip(), "ready")

    def pick(self, **env):
        env.setdefault("DBUS_SESSION_BUS_ADDRESS", self.address)
        return subprocess.run([sys.executable, "-I", "-S", SCRIPT, "Attach files"], env=self.env(**env),
                              capture_output=True, text=True, timeout=20)

    def test_chosen_files_print_one_per_line(self):
        self.fake_portal("pick")
        r = self.pick()
        self.assertEqual((r.returncode, r.stderr), (0, ""))
        self.assertEqual(r.stdout.splitlines(), ["/tmp/demo/a b.png", "/tmp/demo/notes.txt"])
        asked = self.portal.stdout.read()
        self.assertIn("title=Attach files multiple=True", asked)

    def test_cancelling_prints_nothing(self):
        self.fake_portal("cancel")
        r = self.pick()
        self.assertEqual((r.returncode, r.stdout.strip(), r.stderr), (0, "", ""))

    def test_portal_without_filechooser_says_so(self):
        self.fake_portal("nofilechooser")
        r = self.pick()
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stderr.splitlines()[0], "No file picker: xdg-desktop-portal has no FileChooser for this desktop.")
        self.assertIn("UnknownMethod", r.stderr)   # the detail, for the log

    def test_no_portal_running_says_so(self):
        r = self.pick()
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stderr.splitlines()[0], "No file picker: xdg-desktop-portal isn't running.")

    def test_picker_error_says_so(self):
        self.fake_portal("fail")
        r = self.pick()
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stderr.splitlines()[0], "The file picker failed: xdg-desktop-portal's picker ended with an error.")

    def test_no_session_bus_says_so(self):
        r = subprocess.run([sys.executable, "-I", "-S", SCRIPT], env=self.env(XDG_RUNTIME_DIR=self.dir + "/none"),
                           capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(r.stderr.splitlines()[0], "No file picker: the desktop's session bus (D-Bus) isn't reachable from here.")

    def test_no_third_party_module(self):
        # What broke on NixOS: `from gi.repository import ...`. Only the standard library now.
        with open(SCRIPT, encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("import gi", src)
        self.assertNotIn("from gi", src)
        self.assertNotIn("import dbus", src)


class Wire(unittest.TestCase):
    """The marshalling round-trips the portal's own types."""

    def test_round_trip(self):
        pf = load()
        sig = "ssa{sv}ua(ss)"
        val = ("", "Attach files", {"multiple": ("b", True), "uris": ("as", ["file:///a", "file:///b%20c"])}, 7,
               [("k", "v")])
        out = pf.Out()
        for t, v in zip(pf.types(sig), val):
            out.put(t, v)
        r = pf.In(bytes(out.b))
        got = tuple(r.get(t) for t in pf.types(sig))
        self.assertEqual(got[0:2], ("", "Attach files"))
        self.assertEqual(got[2], {"multiple": True, "uris": ["file:///a", "file:///b%20c"]})
        self.assertEqual(got[3:], (7, [("k", "v")]))


if __name__ == "__main__":
    unittest.main()
