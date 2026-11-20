"""A stand-in for xdg-desktop-portal on a private bus, for test_pick_files.py: owns org.freedesktop.portal.Desktop and
answers one FileChooser.OpenFile as the mode says, using pick-files.py's own D-Bus code. Never opens anything.

  python3 fake_portal.py <pick-files.py> pick|cancel|fail|nofilechooser
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("pick_files", sys.argv[1])
pf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pf)
mode = sys.argv[2]

bus = pf.Bus()
bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName", "su",
         ("org.freedesktop.portal.Desktop", 4))
print("ready", flush=True)
while True:
    kind, f, body = bus.read()
    if kind == 1 and f.get(3) == "OpenFile":
        break
serial, who = bus.last, f[7]
if mode == "nofilechooser":
    bus.send(3, [(4, ("s", "org.freedesktop.DBus.Error.UnknownMethod")), (5, ("u", serial)), (6, ("s", who))], "s",
             (f"No such interface '{f[2]}' on object at path {f[1]}",))
    sys.exit(0)
parent, title, opts = body
print(f"title={title} multiple={opts.get('multiple')}", flush=True)
handle = f"/org/freedesktop/portal/desktop/request/{who[1:].replace('.', '_')}/{opts['handle_token']}"
bus.send(2, [(5, ("u", serial)), (6, ("s", who))], "o", (handle,))
code = {"pick": 0, "cancel": 1, "fail": 2}[mode]
results = {"uris": ("as", ["file:///tmp/demo/a%20b.png", "file:///tmp/demo/notes.txt", "https://example.com/x"])} if code == 0 else {}
bus.send(4, [(1, ("o", handle)), (2, ("s", "org.freedesktop.portal.Request")), (3, ("s", "Response")),
             (6, ("s", who))], "ua{sv}", (code, results))
sys.stdout.close()
