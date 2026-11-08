#!/usr/bin/env python3
"""The fork's layer as FORK.md's table states it, for scripts/sync-upstream.sh's check after a merge of upstream.

  python3 scripts/fork_layer.py check   every file the table names is there, and every upstream file it hooks into
                                        still has a `fork:` comment (a file of the layer's own needs none); exit 1 if not
  python3 scripts/fork_layer.py tests   the layer's Bun test files (*.test.ts/js/tsx in the table), one per line

A row's first cell names the layer's own files, then "hooks in" the upstream files it changes. Only paths count
(a `/` in them, or a root file like FORK.md); names like `draw()` or `withForeground` say where in a file.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = re.compile(r"^[\w.-]+(/[\w.-]+)+$|^[\w-]+\.(md|nix|lock)$")
TEST = re.compile(r"\.test\.(ts|tsx|js)$")


def table(text):
    """(own, hooked): the paths the table's rows name, each in the order first named."""
    own, hooked = [], []
    in_layer = False
    for line in text.splitlines():
        if line.startswith("## "):
            in_layer = line.strip() == "## The layer"
            continue
        if not in_layer or not line.startswith("| `"):
            continue
        cell = line.split(" | ")[0][2:]
        parts = re.split(r"\bhooks? in\b", cell, maxsplit=1)
        for names, into in ((parts[0], own), (parts[1] if len(parts) > 1 else "", hooked)):
            for m in re.findall(r"`([^`]+)`", names):
                if PATH.match(m) and m not in into:
                    into.append(m)
    return own, hooked


def problems(root=ROOT):
    """What's wrong with the layer in the tree at root, as lines to show; none when it's intact."""
    with open(os.path.join(root, "FORK.md"), encoding="utf-8") as f:
        own, hooked = table(f.read())
    out = []
    if not own:
        out.append("FORK.md: no layer table found (## The layer)")
    for p in own + hooked:
        if not os.path.isfile(os.path.join(root, p)):
            out.append(f"{p}: named in FORK.md's table, but not there")
    for p in hooked:
        path = os.path.join(root, p)
        if p in own or not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8", errors="replace") as f:
            if "fork:" not in f.read():
                out.append(f"{p}: FORK.md says the layer hooks in here, but it has no `fork:` comment")
    return out


def tests(root=ROOT):
    with open(os.path.join(root, "FORK.md"), encoding="utf-8") as f:
        own, hooked = table(f.read())
    return [p for p in dict.fromkeys(own + hooked) if TEST.search(p)]


def main(argv):
    if argv[1:] == ["check"]:
        found = problems()
        for line in found:
            print(line)
        if not found:
            print("the fork's layer is intact: every file FORK.md names is there, every hook has its fork: comment")
        return 1 if found else 0
    if argv[1:] == ["tests"]:
        print("\n".join(tests()))
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
