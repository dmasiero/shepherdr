// The window's chat (mods/chat), SHEP-46: typing until the words wrap onto a new line, the box didn't grow at first and
// the new line was drawn over the + and Send row; about 6 more letters (or a resize) grew it. The box's height came
// from a hidden copy of the words as plain text, which wraps by other rules than the box's textarea (it kept a line the
// box had already wrapped). Now a hidden textarea like the box measures them. No window runs here: gpui and herdr are
// stand-ins, the measurer's reported height stands for the textarea's own wrap, and these check what is built and
// what the box is sized to at the wrap point.
import { describe, expect, mock, test } from "bun:test";
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
      return (...a: any[]) => { rec.calls.push([String(k), a]); return self; };
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
// A textarea's state: its words and the rows it was given.
class Area {
  v = ""; rows: number[] = []; grow: [number, number] | null = null;
  static new() { return new Area(); }
  value() { return this.v; }
  set_value(v: string) { this.v = v; }
  set_rows(n: number) { this.rows.push(n); }
  set_auto_grow(a: number, b: number) { this.grow = [a, b]; }
}
const textareaOf = new Map<any, Area>();
const Textarea = { new: (s: Area) => { const e = el("Textarea"); textareaOf.set(e.rec, s); return e; } };
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: () => el(), svg: () => el("svg"), image: () => el("image") }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: () => el(), h_flex: () => el(), v_virtual_list: () => el(), Scrollbar: () => el(), TextView: { markdown: () => el() },
  Textarea, TextareaState: Area }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

// What the person typed in the screenshot: the box wrapped "simiarly" onto a third line.
const WORDS = "do you have API access into Ping Gmail? I also want to start a task for moving ping.properties MX records over to HMX2 so that it can obtain 2FA codes to graylog, etc - simiarly to ho";
const LINE = 21;
function chat() {
  const c: any = Object.create(Chat.prototype);
  Object.assign(c, { box: new Area(), meter: new Area(), lineH: LINE, pinned: false });
  c.meter.set_auto_grow(1, 9);
  return c;
}
const cx: any = { notify: () => {} };
// The measurer's box (id chat-text-h) in what boxMeter() built, and its size handler.
function measure(c: any) {
  built.length = 0;
  c.boxMeter();
  const box = built.find((b) => b.calls.some(([n, a]) => n === "id" && a[0] === "chat-text-h"))!;
  const size = box.calls.filter(([n]) => n === "on_size_change").map(([, a]) => a[0]).pop();
  return { box, size };
}

describe("the window chat's box at the wrap point (SHEP-46)", () => {
  test("the words are measured by a textarea like the box, not as plain text", () => {
    const c = chat();
    c.box.set_value(WORDS);
    const { box } = measure(c);
    expect(box.kids.some((k) => typeof k === "string")).toBe(false);
    const area = box.kids.map((k) => k.rec).find((r: Built) => r?.kind === "Textarea");
    expect(area).toBeDefined();
    expect(textareaOf.get(area)).toBe(c.meter);
    // The box's own width and size, out of the Tab order, growing past the 8 rows the box shows.
    expect(area.calls).toContainEqual(["w_full", []]);
    expect(area.calls).toContainEqual(["text_size", [13]]);
    expect(area.calls).toContainEqual(["tab_stop", [false]]);
    expect(c.meter.grow).toEqual([1, 9]);
    // It has the box's words, every render.
    expect(c.meter.value()).toBe(WORDS);
    c.box.set_value(`${WORDS}1`);
    measure(c);
    expect(c.meter.value()).toBe(`${WORDS}1`);
  });

  test("the line the box wraps onto grows it at once: three rows and the spare under the + and Send row", () => {
    const c = chat();
    c.box.set_value(WORDS);
    // Two lines, then the box's own wrap takes "simiarly" onto a third: the measurer grows with it.
    measure(c).size({ width: 600, height: 2 * LINE }, cx);
    expect(c.box.rows.at(-1)).toBe(3);
    measure(c).size({ width: 600, height: 3 * LINE }, cx);
    expect(c.box.rows.at(-1)).toBe(4);
    expect(c.boxSpare).toBe(true);
  });

  test("past 8 lines the box stays at 8 and scrolls", () => {
    const c = chat();
    c.box.set_value("x\n".repeat(12));
    measure(c).size({ width: 600, height: 9 * LINE }, cx);
    expect(c.box.rows.at(-1)).toBe(8);
    expect(c.boxSpare).toBe(false);
  });

  test("at Herdr's zoom the rows come out the same (both heights are at the zoom)", () => {
    const c = chat();
    c.lineH = LINE * 2.3;
    c.box.set_value(WORDS);
    measure(c).size({ width: 600 * 2.3, height: 3 * LINE * 2.3 }, cx);
    expect(c.box.rows.at(-1)).toBe(4);
  });
});
