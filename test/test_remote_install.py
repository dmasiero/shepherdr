"""Fork: Shepherdr's tools sent to another machine from a Nix install. The Nix package's patchShebangs
rewrites `#!/usr/bin/env python3` and `#!/bin/sh` to Nix store paths, so copies sent on as they were
didn't run on a machine without that store (a Mac). Everything that sends a script gets a portable
first line back (base.portable_script, with verbatim copies in the two helpers that stand alone)."""
import ast
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
J = lambda *p: os.path.join(ROOT, *p)
sys.dont_write_bytecode = True
sys.path.insert(0, J("mods", "tasks", "bin"))
from herdr_task import base, machines  # noqa: E402

# Built here, never written out whole: a real store path in the source makes Nix refuse the fetched tree
# (renix's fetchFromGitHub), and this all-zero hash matches no real path (test_repo's test_no_nix_store_paths).
FAKE_HASH = b"0" * 32
NIX_PY = b"#!/nix/store/" + FAKE_HASH + b"-shepherdr-3.1.14/libexec/shepherdr/python3\n"
NIX_SH = b"#!/nix/store/" + FAKE_HASH + b"-bash-5.3p9/bin/sh\n"


def function_source(path, name):
    with open(path) as f:
        text = f.read()
    for node in ast.parse(text).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(text, node)
    return None


class PortableScript(unittest.TestCase):
    def test_nix_interpreters_become_portable(self):
        p = base.portable_script
        self.assertEqual(p(NIX_PY + b"print(1)\n"), b"#!/usr/bin/env python3\nprint(1)\n")
        self.assertEqual(p(NIX_SH + b"echo hi\n"), b"#!/bin/sh\necho hi\n")
        self.assertEqual(p(b"#!/nix/store/x-bash-5.3/bin/bash -e\nx\n"), b"#!/usr/bin/env bash -e\nx\n")
        self.assertEqual(p(b"#!/nix/store/x-coreutils/bin/env node\nx\n"), b"#!/usr/bin/env node\nx\n")
        self.assertEqual(p(b"#!/nix/store/x-python3-3.12/bin/python3.12\nx\n"), b"#!/usr/bin/env python3\nx\n")
        self.assertEqual(p(NIX_SH.rstrip(b"\n")), b"#!/bin/sh")

    def test_anything_else_is_left_as_it_is(self):
        for data in (b"#!/usr/bin/env python3\nx\n", b"#!/bin/sh\nx\n", b"# notes\n", b"", b"PK\x03\x04zip"):
            self.assertIs(base.portable_script(data), data)

    def test_standalone_copies_equal_the_one_source(self):
        src = function_source(J("mods", "tasks", "bin", "herdr_task", "base.py"), "portable_script")
        self.assertTrue(src)
        for path in (J("bin", "herdr-secret"), J("mods", "artifacts", "bin", "herdr-artifact")):
            self.assertEqual(function_source(path, "portable_script"), src, f"{path}: edit base.portable_script, then copy it here")

    def test_herdr_secret_and_herdr_artifact_send_portable_bytes(self):
        for path, needle in ((J("bin", "herdr-secret"), "body = portable_script(f.read())"),
                             (J("mods", "artifacts", "bin", "herdr-artifact"), "body = portable_script(f.read())")):
            with open(path) as f:
                self.assertIn(needle, f.read(), path)


class Sync(unittest.TestCase):
    """The machine sync (herdr-task machines sync): what it sends, and what the other side accepts."""

    def test_manifest_sends_portable_first_lines(self):
        with tempfile.TemporaryDirectory() as home:
            bins = os.path.join(home, ".local", "bin")
            os.makedirs(bins)
            for name, head in (("herdr-secret", NIX_PY), ("herdr-browser", NIX_SH)):
                with open(os.path.join(bins, name), "wb") as f:
                    f.write(head + b"body\n")
            with mock.patch.object(machines, "HOME", home), mock.patch.object(machines, "secrets_main_here", return_value=False):
                files = {f["path"]: f for f in machines.manifest()["files"]}
        self.assertEqual(files[".local/bin/herdr-secret"]["data"], b"#!/usr/bin/env python3\nbody\n")
        self.assertEqual(files[".local/bin/herdr-browser"]["data"], b"#!/bin/sh\nbody\n")
        self.assertEqual(files[".local/bin/herdr-secret"]["sha"], hashlib.sha256(b"#!/usr/bin/env python3\nbody\n").hexdigest())
        self.assertTrue(files[".local/bin/herdr-task"]["data"].startswith(b"#!/usr/bin/env python3\n"))

    def install_there(self, data):
        """The sync's INSTALL script, run as the other machine would (here, in a throwaway home)."""
        with tempfile.TemporaryDirectory() as home:
            payload = {"op": "install", "stamp": ".herdr/tools.json", "from": "test", "version": "v", "force": False,
                       "links": [], "touch": [], "files": [{"path": ".local/bin/tool", "data": base64.b64encode(data).decode(),
                                                            "sha": hashlib.sha256(data).hexdigest(), "mode": 0o755, "at": 1}]}
            env = {"HOME": home, "PATH": "/usr/bin:/bin"}
            r = subprocess.run([sys.executable, "-c", machines.INSTALL], input=json.dumps(payload), capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
            return json.loads(r.stdout)["files"][".local/bin/tool"], os.path.exists(os.path.join(home, ".local/bin/tool"))

    def test_a_script_whose_interpreter_isnt_there_is_refused(self):
        # a store path no machine has (this one may run Nix itself)
        state, there = self.install_there(b"#!/nix/store/0000-gone-bash/bin/sh\necho hi\n")
        self.assertTrue(state.startswith("failed: its interpreter isn't here: /nix/store/"), state)
        self.assertFalse(there)

    def test_a_portable_script_installs(self):
        self.assertEqual(self.install_there(b"#!/bin/sh\necho hi\n"), ("installed", True))


class Browser(unittest.TestCase):
    def test_a_missing_baked_in_agent_browser_falls_back_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = os.path.join(tmp, "agent-browser")
            with open(fake, "w") as f:
                f.write('#!/bin/sh\n[ "$1" = --version ] && { echo "agent-browser 0.41.1"; exit 0; }\necho "ran: $*"\n')
            os.chmod(fake, 0o755)
            env = {"HOME": tmp, "PATH": f"{tmp}:{os.environ.get('PATH', '/usr/bin:/bin')}", "HERDR_BROWSER_BIN": "/nix/store/gone-shepherdr/libexec/agent-browser/bin/agent-browser"}
            r = subprocess.run(["sh", J("bin", "herdr-browser"), "--task", "t#1", "--own", "get", "url"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ran: --session herdr-t-1", r.stdout)


if __name__ == "__main__":
    unittest.main()
