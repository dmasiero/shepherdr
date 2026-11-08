// fork: Claude Code trusts a new space's folder before its Assistant starts there (SHEP-28).
// Claude Code asks "Do you trust this folder?" the first time it runs in a folder, before its session starts. An
// Assistant started for a new space then sat on that screen: nobody at the window to answer it, and a message sent
// from the web meanwhile was typed into it, its Enter picking "No, exit". The person picked the folder for the space,
// so the space's machine notes it as trusted in Claude Code's own config: projects[<folder>].hasTrustDialogAccepted,
// in ~/.claude.json (or $CLAUDE_CONFIG_DIR/.claude.json), the folder only, never one above it, and never the home
// folder or / (a trusted folder may cover the ones under it). A config that isn't there (Claude Code never ran on
// that machine) is left alone.
// Run on the space's machine as `python3 -c TRUST <folder>` (herdr-task needs python3 on every machine Shepherdr
// runs on): the service (service/spaces.ts, service/actions.ts) and the window (lib/coordinator.js) alike. Claude
// Code writes the file often, so it is replaced only if it still reads as it did, and tried again otherwise.
// It prints what it did: "set", "trusted" (already), "skipped" (home or /), "none" (no config), "busy" (kept changing; nothing written).
// Shared core: the source is core/claude-trust.js; bin/sync-shared copies it into the mods in lib/COPIES.

export const TRUST = `import json, os, sys, time
d = os.environ.get("CLAUDE_CONFIG_DIR")
f = os.path.join(d, ".claude.json") if d else os.path.expanduser("~/.claude.json")
folder = os.path.realpath(os.path.expanduser(sys.argv[1]))
if folder in ("/", os.path.realpath(os.path.expanduser("~"))): print("skipped"); sys.exit(0)
for i in range(5):
    try:
        with open(f, "rb") as h: raw = h.read()
    except FileNotFoundError:
        print("none"); sys.exit(0)
    try:
        c = json.loads(raw)
    except ValueError:
        time.sleep(0.2); continue
    if not isinstance(c, dict) or not isinstance(c.get("projects", {}), dict): print("none"); sys.exit(0)
    e = c.setdefault("projects", {}).setdefault(folder, {})
    if not isinstance(e, dict): print("none"); sys.exit(0)
    if e.get("hasTrustDialogAccepted") is True: print("trusted"); sys.exit(0)
    e["hasTrustDialogAccepted"] = True
    t = "%s.herdr-trust-%d" % (f, os.getpid())
    with open(t, "w") as h: json.dump(c, h, indent=2, ensure_ascii=False)
    os.chmod(t, os.stat(f).st_mode & 0o777)
    with open(f, "rb") as h: now = h.read()
    if now != raw:
        os.unlink(t); time.sleep(0.1); continue
    os.replace(t, f)
    print("set"); sys.exit(0)
print("busy"); sys.exit(1)
`;

/** The program and arguments that trust `folder` (absolute, or ~/…) on the machine they run on. */
export const trustArgv = (folder) => ["python3", "-c", TRUST, folder];
