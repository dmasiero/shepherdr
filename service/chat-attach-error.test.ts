// The window chat's + (attach) button on NixOS + sway (SHEP-75): pick-files.py needed PyGObject, NixOS's python3 has
// none, and the chat only said "Couldn't open the file picker." in its general error line, drawn at the pane's left
// edge above the status line, far from the box. Now the picker script says why, and the chat shows that inside the
// composer, above the + it came from. No window runs here: gpui and herdr are stand-ins, exec answers as the script
// would, and these check what pickFiles() keeps and where composer() draws it.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

type Built = { kind: string; calls: [string, any[]][]; kids: any[] };
const built: Built[] = [];
function el(kind = "div"): any {
  const rec: Built = { kind, calls: [], kids: [] };
  built.push(rec);
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "rec") return rec;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      if (k === "child") return (v: any) => { rec.calls.push(["child", [v]]); rec.kids.push(v); return self; };
      if (k === "children") return (v: any[]) => { for (const x of v) rec.kids.push(x); return self; };
      return (...a: any[]) => { rec.calls.push([String(k), a]); return self; };
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
class Area {
  v = "";
  static new() { return new Area(); }
  value() { return this.v; }
  set_value(v: string) { this.v = v; }
  set_rows() {}
  set_auto_grow() {}
  focus() {}
}
let answer: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "", stderr: "" };
const execs: string[][] = [];
mock.module("herdr", () => fakeHerdr({
  settings: () => ({}), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async (cmd: string, args: string[]) => { execs.push([cmd, ...args]); return answer; },
  hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: () => el(), svg: () => el("svg"), image: () => el("image") }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: () => el(), h_flex: () => el(), v_virtual_list: () => el(), Scrollbar: () => el(), TextView: { markdown: () => el() },
  Textarea: { new: () => el("Textarea") }, TextareaState: Area }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");
const attach = await import("../mods/chat/attach.js");

function chat() {
  const c: any = Object.create(Chat.prototype);
  Object.assign(c, { box: new Area(), meter: new Area(), files: [], views: {}, asks: [], phase: "ready", dict: { state: "idle" }, recall: -1,
    slashSel: 0, lineH: 21, saveSoon: () => {} });
  return c;
}
// cx.spawn runs the job and keeps its promise, to wait on.
function cx() {
  const jobs: Promise<unknown>[] = [];
  const c: any = { notify: () => {}, stop_propagation: () => {}, spawn: (f: any) => { jobs.push(f(c)); }, jobs };
  return c;
}
const textOf = (r: Built): string[] => r.kids.flatMap((k) => (typeof k === "string" ? [k] : k?.rec ? textOf(k.rec) : []));
const within = (r: Built, id: string): Built | undefined => {
  if (r.calls.some(([n, a]) => n === "id" && a[0] === id)) return r;
  for (const k of r.kids) { const f = k?.rec && within(k.rec, id); if (f) return f; }
};

// What nextgate's herdr-app got before (main's pick-files.py, NixOS python3 without gi), and what the script says now.
const NO_GI = "Traceback (most recent call last):\n  File \"pick-files.py\", line 8, in <module>\nModuleNotFoundError: No module named 'gi'";
const NO_FILECHOOSER = "No file picker: xdg-desktop-portal has no FileChooser for this desktop.\norg.freedesktop.DBus.Error.UnknownMethod: No such interface";

describe("the attach button's error (SHEP-75)", () => {
  beforeEach(() => { execs.length = 0; built.length = 0; });

  test("the picker script's own words are what the chat says, and the detail is logged", async () => {
    answer = { code: 2, stdout: "", stderr: NO_FILECHOOSER };
    const logged: string[] = [];
    const was = console.error;
    console.error = (m: string) => logged.push(m);
    try {
      const r = await attach.pick();
      expect(r.code).toBe(2);
      expect(r.error).toBe("No file picker: xdg-desktop-portal has no FileChooser for this desktop.");
    } finally { console.error = was; }
    expect(logged.join("\n")).toContain("UnknownMethod");
  });

  test("no python3 at all says so; a crash without plain words keeps the old line", async () => {
    answer = { code: 127, stdout: "", stderr: "sh: python3: not found" };
    expect((await attach.pick()).error).toBe("No file picker: python3 isn't installed.");
    answer = { code: 1, stdout: "", stderr: NO_GI };
    expect((await attach.pick()).error).toBe("Couldn't open the file picker.");
    answer = { code: 0, stdout: "/tmp/demo/a.png\n", stderr: "" };
    expect((await attach.pick()).error).toBeUndefined();
  });

  test("the error is drawn inside the composer, not in the pane's error line", async () => {
    answer = { code: 2, stdout: "", stderr: NO_FILECHOOSER };
    const c = chat(), x = cx();
    c.pickFiles(x);
    await Promise.all(x.jobs);
    expect(c.error).toBeUndefined();
    expect(c.attachError).toBe("No file picker: xdg-desktop-portal has no FileChooser for this desktop.");
    const out = c.composer(theme, "idle", x);
    const box = within(out.rec, "chat-composer")!;
    expect(box).toBeDefined();
    const line = within(box, "chat-attach-error")!;
    expect(line).toBeDefined();
    expect(textOf(line)).toEqual([c.attachError]);
    expect(line.calls).not.toContainEqual(["truncate", []]);
    // Just above the row with the + button, inside the same box.
    const order = box.kids.map((k) => k?.rec).filter(Boolean);
    const at = order.indexOf(line), plus = order.findIndex((r: Built) => within(r, "chat-attach"));
    expect(at).toBeGreaterThan(-1);
    expect(plus).toBe(at + 1);
  });

  test("files picked or pasted clear it", async () => {
    const c = chat(), x = cx();
    c.attachError = "No file picker: xdg-desktop-portal isn't running.";
    answer = { code: 0, stdout: "/tmp/demo/a.png\n", stderr: "" };
    c.pickFiles(x);
    await Promise.all(x.jobs);
    expect(c.attachError).toBeNull();
    expect(c.files.map((f: any) => f.path)).toEqual(["/tmp/demo/a.png"]);
    built.length = 0;
    expect(within(c.composer(theme, "idle", x).rec, "chat-attach-error")).toBeUndefined();
  });
});
