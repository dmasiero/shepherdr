"""herdr-artifact from a read-only install (fork, upstream #749): with Shepherdr's files read-only, as a Nix store makes
them, publish still stages, checks (the light look rewrites the staged copies) and installs a recipe. Runs in a
throwaway store with a fake herdr-app check; nothing real is installed."""
import importlib.machinery
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_loader = importlib.machinery.SourceFileLoader("herdr_artifact_readonly_under_test",
                                               os.path.join(ROOT, "mods", "artifacts", "bin", "herdr-artifact"))
A = importlib.util.module_from_spec(importlib.util.spec_from_loader(_loader.name, _loader))
_loader.exec_module(A)

RECIPE = '{"recipe": 1, "title": "Report", "blocks": [{"type": "text", "text": "hi"}]}\n'


def read_only(top):
    for root, dirs, names in os.walk(top):
        for n in names:
            p = os.path.join(root, n)
            os.chmod(p, os.stat(p).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
    for root, dirs, _names in os.walk(top, topdown=False):
        for n in dirs:
            p = os.path.join(root, n)
            os.chmod(p, os.stat(p).st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))


def writable(top):
    for root, dirs, names in os.walk(top):
        for n in dirs + names:
            p = os.path.join(root, n)
            os.chmod(p, os.stat(p).st_mode | stat.S_IWUSR)


class ReadOnlyInstall(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="shepherdr-artifact-ro-")
        # Shepherdr's own files, read-only: the recipe view, its core and Mark up.
        inst = os.path.join(self.dir, "install")
        src = os.path.join(ROOT, "mods", "artifacts")
        os.makedirs(os.path.join(inst, "core"))
        for rel in ("recipe-view.js", "markup.js", os.path.join("core", "recipe.js")):
            shutil.copyfile(os.path.join(src, rel), os.path.join(inst, rel))
        # The artifact's own files, read-only too (a recipe made from a read-only checkout).
        self.art = os.path.join(self.dir, "report")
        os.makedirs(self.art)
        with open(os.path.join(self.art, "recipe.json"), "w") as f:
            f.write(RECIPE)
        read_only(inst)
        read_only(self.art)
        self.folder = os.path.join(self.dir, "proj")
        os.makedirs(self.folder)
        self.app = os.path.join(self.dir, "app")
        os.makedirs(os.path.join(self.app, "mods"))
        store = os.path.join(self.dir, "store")
        self.checked = []

        def fake_run(args, cwd=None, input=None):
            if args[:2] == ["herdr-app", "check"]:
                self.checked.append(args[2])
                return subprocess.CompletedProcess(args, 0, "", "")
            return subprocess.CompletedProcess(args, 1, "", "not here")

        self.patches = [mock.patch.object(A, "STORE", store), mock.patch.object(A, "FILES", os.path.join(store, "files")),
                        mock.patch.object(A, "NOTES", os.path.join(store, "notes")),
                        mock.patch.object(A, "APP", self.app),
                        mock.patch.object(A, "RECIPE_VIEW", os.path.join(inst, "recipe-view.js")),
                        mock.patch.object(A, "RECIPE_CORE", os.path.join(inst, "core", "recipe.js")),
                        mock.patch.object(A, "MARKUP", os.path.join(inst, "markup.js")),
                        mock.patch.object(A.shutil, "which", side_effect=lambda n: "/fake/herdr-app" if n == "herdr-app" else None),
                        mock.patch.object(A, "run", side_effect=fake_run),
                        mock.patch.object(A, "me", return_value={"terminal": "t9", "task": None})]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        writable(self.dir)
        shutil.rmtree(self.dir, ignore_errors=True)

    def publish(self, **k):
        base = dict(id=None, title="Report", folder=self.folder, task=None, note=None, json=True, custom=False, dir=self.art)
        with mock.patch("sys.stdout"):
            A.cmd_publish(types.SimpleNamespace(**{**base, **k}))

    def test_a_read_only_source_tree_really_is_read_only(self):
        if os.geteuid() == 0:
            self.skipTest("root writes read-only files")
        with self.assertRaises(PermissionError):
            open(A.RECIPE_VIEW, "w").close()

    def test_publish_stages_checks_and_installs_from_read_only_files(self):
        self.publish()
        self.assertEqual(len(self.checked), 2)  # dark, then light (stage_theme rewrote the staged recipe view)
        with A.Store(A.locate(self.folder), write=False) as s:
            art = s.data["artifacts"][0]
        mod = os.path.join(self.app, "mods", f"art-{art['id']}")
        for n in ("recipe.json", "recipe-view.js", "recipe.js", "artifact-markup.js", "main.js", "artifact.js"):
            self.assertTrue(os.path.isfile(os.path.join(mod, n)), n)
        # The installed copies are writable, so the next version replaces them.
        self.assertTrue(os.access(os.path.join(mod, "recipe-view.js"), os.W_OK))
        self.publish(id=art["id"])
        with A.Store(A.locate(self.folder), write=False) as s:
            self.assertEqual(len(s.data["artifacts"][0]["versions"]), 2)


if __name__ == "__main__":
    unittest.main()
