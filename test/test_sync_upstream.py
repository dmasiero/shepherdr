"""The fork's sync with upstream (FORK.md): scripts/sync-upstream.sh as renix runs it (`--ref`, `--continue`, `--dir`;
exit 3 on conflicts, 4 on a failed check), on throwaway git repos with a fake gh, and scripts/fork_layer.py, which
reads FORK.md's table for the layer's tests and its `fork:` hooks."""
import home_guard  # noqa: F401  (first: every test on a throwaway home, never the real one)
import importlib.util
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "sync-upstream.sh")

spec = importlib.util.spec_from_file_location("fork_layer", os.path.join(ROOT, "scripts", "fork_layer.py"))
fork_layer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fork_layer)


class Layer(unittest.TestCase):
    def test_this_tree_has_the_whole_layer(self):
        self.assertEqual(fork_layer.problems(), [])
        tests = fork_layer.tests()
        self.assertIn("service/proxy.test.ts", tests)
        self.assertTrue(all(os.path.isfile(os.path.join(ROOT, t)) for t in tests), tests)
        self.assertFalse([t for t in tests if t.endswith(".py")], "Python tests run with the whole unittest suite")

    def test_the_check_workflow_runs_on_the_fork_line(self):
        # task and sync pull requests to the fork's line, main, and each merge into it, get GitHub's whole Check
        # (SHEP-25); 3.x, the line before it (SHEP-56), stays listed until it's deleted
        workflow = read(os.path.join(ROOT, ".github", "workflows", "check.yml"))
        self.assertIn("  pull_request:\n    branches: [main, 3.x]\n", workflow)
        self.assertIn("  push:\n    branches: [main, 3.x]\n", workflow)
        self.assertIn(".github/workflows/check.yml", fork_layer.table(read(os.path.join(ROOT, "FORK.md")))[1])

    def test_the_table_names_own_files_then_hooks(self):
        own, hooked = fork_layer.table(textwrap.dedent("""\
            ## The layer

            | File | What |
            | --- | --- |
            | `FORK.md` | This page. |
            | `a/new.ts`, `a/new.test.ts`; hooks in `b/up.ts` (`draw()`, `withForeground`), `lib/COPIES` | Why. |
            | `test/x.py` (`Case`); hook in `b/up.ts` | Again. |

            ## Not the layer

            | `c/other.ts` | Not counted. |
            """))
        self.assertEqual(own, ["FORK.md", "a/new.ts", "a/new.test.ts", "test/x.py"])
        self.assertEqual(hooked, ["b/up.ts", "lib/COPIES"])

    def test_a_lost_hook_or_file_is_a_problem(self):
        root = tempfile.mkdtemp(prefix="fork-layer-")
        self.addCleanup(shutil.rmtree, root)

        def put(rel, text):
            os.makedirs(os.path.dirname(os.path.join(root, rel)), exist_ok=True)
            with open(os.path.join(root, rel), "w") as f:
                f.write(text)
        put("FORK.md", "## The layer\n\n| `a/own.ts`, `a/gone.ts`; hooks in `b/kept.ts`, `b/lost.ts`, `a/own.ts` | x |\n")
        put("a/own.ts", "no marker: the layer's own file\n")
        put("b/kept.ts", "// fork: the hook\n")
        put("b/lost.ts", "upstream's change took the hook out\n")
        found = fork_layer.problems(root)
        self.assertEqual(len(found), 2, found)
        self.assertIn("a/gone.ts", found[0])
        self.assertIn("b/lost.ts", found[1])


# git with a throwaway identity, none of the machine's config
GIT_ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}


def git(cwd, *args):
    return subprocess.run(["git", "-c", "init.defaultBranch=main", *args], cwd=cwd, check=True, env=GIT_ENV,
                          capture_output=True, text=True).stdout.strip()


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Sync(unittest.TestCase):
    """A fork (origin, its line on its own main) and an upstream (main) as local repos, and renix's clone of the fork."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sync-upstream-")
        self.addCleanup(shutil.rmtree, self.tmp)
        t = self.tmp
        self.env = dict(GIT_ENV)
        # a fake gh, first on PATH: it notes every call; `pr list` finds none open
        bindir = os.path.join(t, "bin")
        os.makedirs(bindir)
        self.gh_log = os.path.join(t, "gh.log")
        with open(os.path.join(bindir, "gh"), "w") as f:
            f.write(f'#!/bin/sh\necho "$*" >> {self.gh_log}\n')
        os.chmod(os.path.join(bindir, "gh"), 0o755)
        self.env["PATH"] = bindir + os.pathsep + os.environ["PATH"]

        git(t, "init", "--quiet", "--bare", "upstream.git")
        git(t, "init", "--quiet", "--bare", "origin.git")
        git(t, "clone", "--quiet", os.path.join(t, "upstream.git"), "up")
        self.up = os.path.join(t, "up")
        self.commit(self.up, {"package.json": '{\n  "version": "1.0.0"\n}\n', "a.txt": "one\ntwo\n"}, "1.0.0")
        git(self.up, "push", "--quiet", "origin", "HEAD:main")
        # the fork: upstream's 1.0.0 plus its layer, on its own main
        git(t, "clone", "--quiet", os.path.join(t, "origin.git"), "fork")
        fork = os.path.join(t, "fork")
        git(fork, "fetch", "--quiet", os.path.join(t, "upstream.git"), "main")
        git(fork, "checkout", "--quiet", "-B", "main", "FETCH_HEAD")
        self.commit(fork, {"fork.txt": "the layer\n"}, "[fork] the layer")
        git(fork, "push", "--quiet", "origin", "main")
        # renix's clone: origin and upstream remotes, detached on origin/main, the script in it
        git(t, "clone", "--quiet", os.path.join(t, "origin.git"), "repo")
        self.repo = os.path.join(t, "repo")
        git(self.repo, "remote", "add", "upstream", os.path.join(t, "upstream.git"))
        git(self.repo, "checkout", "--quiet", "--detach", "origin/main")
        os.makedirs(os.path.join(self.repo, "scripts"))
        shutil.copy(SCRIPT, os.path.join(self.repo, "scripts", "sync-upstream.sh"))
        self.wt = os.path.join(t, "worktree")

    def commit(self, cwd, files, message):
        for name, text in files.items():
            with open(os.path.join(cwd, name), "w") as f:
                f.write(text)
        git(cwd, "add", "-A")
        git(cwd, "commit", "--quiet", "-m", message)
        return git(cwd, "rev-parse", "HEAD")

    def upstream_release(self, version, a="one\ntwo\n"):
        sha = self.commit(self.up, {"package.json": f'{{\n  "version": "{version}"\n}}\n', "a.txt": a}, version)
        git(self.up, "push", "--quiet", "origin", "HEAD:main")
        return sha

    def sync(self, *args, check="true"):
        return subprocess.run(["sh", "scripts/sync-upstream.sh", "--ref", "upstream/main", *args, "--dir", self.wt],
                              cwd=self.repo, env={**self.env, "SHEPHERDR_SYNC_CHECK": check},
                              capture_output=True, text=True, stdin=subprocess.DEVNULL)

    def gh_calls(self):
        return read(self.gh_log).splitlines() if os.path.exists(self.gh_log) else []

    def assert_merged(self, sha):
        parents = git(self.wt, "log", "-1", "--format=%P").split()
        self.assertEqual(len(parents), 2, "a merge commit")
        self.assertEqual(parents[1], sha)
        self.assertEqual(git(self.tmp + "/origin.git", "rev-parse", "sync/upstream-1.1.0"), git(self.wt, "rev-parse", "HEAD"))
        create = [c for c in self.gh_calls() if c.startswith("pr create")]
        self.assertEqual(len(create), 1, self.gh_calls())
        self.assertIn("--base main --head sync/upstream-1.1.0 --title Sync with upstream 1.1.0", create[0])

    def test_nothing_new_makes_no_worktree(self):
        p = self.sync()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("nothing to do", p.stderr)
        self.assertFalse(os.path.exists(self.wt))
        self.assertEqual(self.gh_calls(), [])

    def test_a_clean_merge_is_checked_pushed_and_opened(self):
        sha = self.upstream_release("1.1.0", a="one\ntwo\nthree\n")
        p = self.sync()
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assert_merged(sha)
        self.assertEqual(git(self.wt, "rev-parse", "--abbrev-ref", "HEAD"), "sync/upstream-1.1.0")
        self.assertEqual(read(os.path.join(self.wt, "fork.txt")), "the layer\n")
        self.assertNotEqual(git(self.tmp + "/origin.git", "rev-parse", "main"), git(self.wt, "rev-parse", "HEAD"),
                            "the fork's main itself is never pushed")
        body = read(os.path.join(git(self.wt, "rev-parse", "--absolute-git-dir"), "sync-upstream.pr.md"))
        self.assertIn("GitHub's Check workflow runs on this pull request", body)
        self.assertNotIn("main only", body)

    def test_conflicts_stop_with_3_then_continue_commits_the_merge(self):
        fork = os.path.join(self.tmp, "fork")
        self.commit(fork, {"a.txt": "one\nfork's two\n"}, "[fork] hook in a.txt")
        git(fork, "push", "--quiet", "origin", "main")
        sha = self.upstream_release("1.1.0", a="one\nupstream's two\n")
        p = self.sync()
        self.assertEqual(p.returncode, 3, p.stderr)
        self.assertIn("a.txt", p.stderr)
        state = read(os.path.join(git(self.wt, "rev-parse", "--absolute-git-dir"), "sync-upstream"))
        self.assertIn(f"ref={sha}\n", state)
        # still conflicted, or markers staged: 3 again
        self.assertEqual(self.sync("--continue").returncode, 3)
        git(self.wt, "add", "a.txt")
        self.assertEqual(self.sync("--continue").returncode, 3)
        # resolved (upstream's change, the fork's back on top) and staged, as renix's agent leaves it
        with open(os.path.join(self.wt, "a.txt"), "w") as f:
            f.write("one\nupstream's two  # fork: the hook\n")
        git(self.wt, "add", "a.txt")
        # upstream moved on meanwhile: --continue still merges the commit it saved
        self.upstream_release("1.2.0", a="one\nupstream's two\nthree\n")
        git(self.repo, "fetch", "--quiet", "upstream")
        p = self.sync("--continue")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assert_merged(sha)
        self.assertIn("- `a.txt`", read(os.path.join(git(self.wt, "rev-parse", "--absolute-git-dir"), "sync-upstream.pr.md")))

    def test_a_failed_check_stops_with_4_then_continue_checks_again(self):
        sha = self.upstream_release("1.1.0", a="one\ntwo\nthree\n")
        p = self.sync(check="echo the check broke; exit 1")
        self.assertEqual(p.returncode, 4, p.stderr)
        self.assertIn("the check broke", p.stderr)
        log = os.path.join(git(self.wt, "rev-parse", "--absolute-git-dir"), "sync-upstream.check.log")
        self.assertIn("the check broke", read(log))
        self.assertEqual(self.gh_calls(), [], "nothing pushed or opened")
        # the agent commits a fix; the check passes now
        self.commit(self.wt, {"fix.txt": "fixed\n"}, "Fix the check after the merge")
        p = self.sync("--continue")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(git(self.tmp + "/origin.git", "rev-parse", "sync/upstream-1.1.0"), git(self.wt, "rev-parse", "HEAD"))
        git(self.wt, "merge-base", "--is-ancestor", sha, "HEAD")  # raises unless upstream's commit is merged

    def test_the_check_runs_at_low_priority(self):
        self.upstream_release("1.1.0", a="one\ntwo\nthree\n")
        p = self.sync(check="test \"$(nice)\" -ge 19 || { echo \"nice is $(nice)\"; exit 1; }")
        self.assertEqual(p.returncode, 0, p.stderr)


if __name__ == "__main__":
    unittest.main()
