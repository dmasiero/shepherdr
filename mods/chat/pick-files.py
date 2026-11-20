#!/usr/bin/env python3
# The desktop's own file picker (xdg-desktop-portal FileChooser), several files at once, for the
# chat's attach button: prints each chosen path on its own line; nothing when cancelled.
# Herdr's mods have a folder picker only (pickFolder), so the chat runs this.
#
# fork: SHEP-75. It spoke D-Bus through PyGObject (gi), which a plain python3 lacks (NixOS's, a venv's), so the
# button only said "Couldn't open the file picker.". It now speaks D-Bus itself, standard library only, and when no
# picker can open it says why on stderr in one plain line (exit 2), which the chat shows.
import os
import socket
import struct
import sys
from urllib.parse import unquote, urlparse

PORTAL = "org.freedesktop.portal.Desktop"
FILECHOOSER = "org.freedesktop.portal.FileChooser"


class Fail(Exception):
    """A plain reason no picker opened, for the person; `detail` for the log."""

    def __init__(self, words, detail=""):
        super().__init__(words)
        self.detail = detail


# --- D-Bus's wire format (little-endian), only as much as the portal needs ---

ALIGN = {"y": 1, "b": 4, "n": 2, "q": 2, "i": 4, "u": 4, "x": 8, "t": 8, "d": 8, "h": 4,
         "s": 4, "o": 4, "g": 1, "a": 4, "(": 8, "{": 8, "v": 1}
FIXED = {"y": "B", "b": "I", "n": "h", "q": "H", "i": "i", "u": "I", "x": "q", "t": "Q", "d": "d", "h": "I"}


def one(sig, i=0):
    """The end of the single complete type starting at sig[i]."""
    c = sig[i]
    if c == "a":
        return one(sig, i + 1)
    if c in "({":
        close = ")" if c == "(" else "}"
        i += 1
        while sig[i] != close:
            i = one(sig, i)
        return i + 1
    return i + 1


def types(sig):
    out, i = [], 0
    while i < len(sig):
        j = one(sig, i)
        out.append(sig[i:j])
        i = j
    return out


class Out:
    def __init__(self):
        self.b = bytearray()

    def pad(self, n):
        self.b += b"\0" * (-len(self.b) % n)

    def put(self, t, v):
        c = t[0]
        self.pad(ALIGN[c])
        if c in FIXED:
            self.b += struct.pack("<" + FIXED[c], int(v) if c == "b" else v)
        elif c in "so":
            s = v.encode()
            self.b += struct.pack("<I", len(s)) + s + b"\0"
        elif c == "g":
            s = v.encode()
            self.b += bytes([len(s)]) + s + b"\0"
        elif c == "v":
            sig, val = v
            self.put("g", sig)
            self.put(sig, val)
        elif c == "a":
            at = len(self.b)
            self.b += b"\0\0\0\0"
            self.pad(ALIGN[t[1]])
            start = len(self.b)
            items = v.items() if t[1] == "{" else v
            for x in items:
                self.put(t[1:], x)
            struct.pack_into("<I", self.b, at, len(self.b) - start)
        elif c in "({":
            for sub, x in zip(types(t[1:-1]), v):
                self.put(sub, x)


class In:
    def __init__(self, b, at=0):
        self.b, self.at = b, at

    def get(self, t):
        c = t[0]
        self.at += -self.at % ALIGN[c]
        if c in FIXED:
            f = "<" + FIXED[c]
            v = struct.unpack_from(f, self.b, self.at)[0]
            self.at += struct.calcsize(f)
            return bool(v) if c == "b" else v
        if c in "so":
            n = struct.unpack_from("<I", self.b, self.at)[0]
            v = self.b[self.at + 4:self.at + 4 + n].decode("utf-8", "replace")
            self.at += 4 + n + 1
            return v
        if c == "g":
            n = self.b[self.at]
            v = self.b[self.at + 1:self.at + 1 + n].decode()
            self.at += 1 + n + 1
            return v
        if c == "v":
            sig = self.get("g")
            return self.get(sig)
        if c == "a":
            n = self.get("u")
            self.at += -self.at % ALIGN[t[1]]
            end, items = self.at + n, []
            while self.at < end:
                items.append(self.get(t[1:]))
            return dict(items) if t[1] == "{" else items
        if c in "({":
            return tuple(self.get(sub) for sub in types(t[1:-1]))
        raise ValueError(f"D-Bus type {t!r}")


def address():
    """The session bus's socket address, as socket.connect takes it."""
    env = os.environ.get("DBUS_SESSION_BUS_ADDRESS")
    if not env:
        run = os.environ.get("XDG_RUNTIME_DIR")
        if run and os.path.exists(f"{run}/bus"):
            return f"{run}/bus"
        raise Fail("No file picker: the desktop's session bus (D-Bus) isn't reachable from here.",
                   "DBUS_SESSION_BUS_ADDRESS is unset and $XDG_RUNTIME_DIR/bus is missing")
    for part in env.split(";"):
        kind, _, rest = part.partition(":")
        keys = dict(kv.split("=", 1) for kv in rest.split(",") if "=" in kv)
        if kind == "unix" and "path" in keys:
            return unquote(keys["path"])
        if kind == "unix" and "abstract" in keys:
            return "\0" + unquote(keys["abstract"])
    raise Fail("No file picker: the desktop's session bus (D-Bus) isn't reachable from here.",
               f"no unix address in DBUS_SESSION_BUS_ADDRESS={env}")


class Bus:
    def __init__(self):
        where = address()
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.connect(where)
        except OSError as e:
            raise Fail("No file picker: the desktop's session bus (D-Bus) isn't reachable from here.",
                       f"connect {where!r}: {e}")
        self.buf = b""
        self.serial = 0
        self.sock.sendall(b"\0AUTH EXTERNAL " + str(os.getuid()).encode().hex().encode() + b"\r\n")
        line = self.line()
        if not line.startswith(b"OK"):
            raise Fail("No file picker: the desktop's session bus (D-Bus) refused this window.", f"auth: {line!r}")
        self.sock.sendall(b"BEGIN\r\n")
        self.signals = []
        self.name = self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello")[0]

    def line(self):
        while b"\r\n" not in self.buf:
            got = self.sock.recv(4096)
            if not got:
                raise Fail("No file picker: the desktop's session bus (D-Bus) closed the connection.", "eof in auth")
            self.buf += got
        line, _, self.buf = self.buf.partition(b"\r\n")
        return line

    def exactly(self, n):
        while len(self.buf) < n:
            got = self.sock.recv(65536)
            if not got:
                raise Fail("No file picker: the desktop's session bus (D-Bus) closed the connection.", "eof")
            self.buf += got
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, kind, fields, sig="", body=()):
        self.serial += 1
        b = Out()
        for t, v in zip(types(sig), body):
            b.put(t, v)
        h = Out()
        if sig:
            fields = fields + [(8, ("g", sig))]
        h.put("y", ord("l"))
        h.put("y", kind)
        h.put("y", 0)
        h.put("y", 1)
        h.put("u", len(b.b))
        h.put("u", self.serial)
        h.put("a(yv)", fields)
        h.pad(8)
        self.sock.sendall(bytes(h.b) + bytes(b.b))
        return self.serial

    def read(self):
        """The next message: (type, {field code: value}, body tuple)."""
        head = self.exactly(16)
        if head[0:1] != b"l":
            raise Fail("No file picker: the desktop's session bus (D-Bus) answered in a way this can't read.",
                       "big-endian message")
        kind = head[1]
        self.last = struct.unpack_from("<I", head, 8)[0]   # its serial, for an answer to it
        blen, flen = struct.unpack_from("<I", head, 4)[0], struct.unpack_from("<I", head, 12)[0]
        rest = self.exactly(flen + (-(16 + flen) % 8) + blen)
        whole = head + rest
        fields = dict(In(whole, 12).get("a(yv)"))
        start = 16 + flen + (-(16 + flen) % 8)
        sig = fields.get(8, "")
        r = In(whole[start:])
        body = tuple(r.get(t) for t in types(sig))
        return kind, fields, body

    def call(self, dest, path, iface, member, sig="", body=()):
        serial = self.send(1, [(1, ("o", path)), (2, ("s", iface)), (3, ("s", member)), (6, ("s", dest))], sig, body)
        while True:
            kind, fields, out = self.read()
            if kind == 4:
                self.signals.append((fields, out))
            elif kind in (2, 3) and fields.get(5) == serial:
                if kind == 3:
                    raise DBusError(fields.get(4, ""), out[0] if out and isinstance(out[0], str) else "")
                return out


class DBusError(Exception):
    def __init__(self, name, message):
        super().__init__(f"{name}: {message}")
        self.name = name


def pick(title):
    bus = Bus()
    token = f"herdr_chat_{os.getpid()}"
    sender = bus.name[1:].replace(".", "_")
    want = {f"/org/freedesktop/portal/desktop/request/{sender}/{token}"}
    # Listen before asking, so the answer can't come first.
    bus.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s",
             ("type='signal',interface='org.freedesktop.portal.Request',member='Response'",))
    try:
        handle = bus.call(PORTAL, "/org/freedesktop/portal/desktop", FILECHOOSER, "OpenFile", "ssa{sv}", (
            "", title, {
                "handle_token": ("s", token),
                "multiple": ("b", True),
                "accept_label": ("s", "Attach"),
            }))[0]
    except DBusError as e:
        if e.name in ("org.freedesktop.DBus.Error.ServiceUnknown", "org.freedesktop.DBus.Error.NameHasNoOwner"):
            raise Fail("No file picker: xdg-desktop-portal isn't running.", str(e))
        if e.name in ("org.freedesktop.DBus.Error.UnknownMethod", "org.freedesktop.DBus.Error.UnknownInterface",
                      "org.freedesktop.DBus.Error.UnknownObject"):
            raise Fail("No file picker: xdg-desktop-portal has no FileChooser for this desktop.", str(e))
        raise Fail("The file picker didn't open: xdg-desktop-portal refused.", str(e))
    want.add(handle)   # an old portal may answer on a path of its own
    while True:
        for fields, body in bus.signals:
            if fields.get(1) in want and fields.get(3) == "Response":
                code, results = body
                if code == 1:
                    return []
                if code != 0:
                    raise Fail("The file picker failed: xdg-desktop-portal's picker ended with an error.",
                               f"Response code {code}")
                return [unquote(u.path) for u in map(urlparse, results.get("uris", [])) if u.scheme == "file"]
        bus.signals = []
        kind, fields, body = bus.read()
        if kind == 4:
            bus.signals.append((fields, body))


def main():
    title = sys.argv[1] if len(sys.argv) > 1 else "Attach files"
    try:
        chosen = pick(title)
    except Fail as e:
        print(f"{e}" + (f"\n{e.detail}" if e.detail else ""), file=sys.stderr)
        return 2
    except Exception as e:  # a bug here, or a bus answer this can't read: still one plain line first
        print(f"The file picker didn't open: {type(e).__name__}.\n{e!r}", file=sys.stderr)
        return 2
    print("\n".join(chosen))
    return 0


if __name__ == "__main__":
    sys.exit(main())
