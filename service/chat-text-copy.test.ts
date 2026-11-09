// The window's chat (mods/chat), SHEP-37: Ctrl+C on a highlight in the messages copies it. A drag over a message gives
// that message's text the keyboard (Herdr's TextView copies its highlight on Ctrl+C); the chat's refocus() used to
// give it straight back to the message box, so the key reached the empty box. No window runs here: gpui and herdr are
// stand-ins, and these check when the box waits and when it takes the keyboard back.
import { describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: el } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

function chat() {
  const c: any = Object.create(Chat.prototype);
  const box = { focused: 0, typed: [] as string[], focus() { this.focused++; }, replace(t: string) { this.typed.push(t); } };
  // The pane focused for a while, the box shown, the last press long ago: refocus() would give the box the keyboard.
  Object.assign(c, { box, focused: false, textSel: null, call: null, finding: false, wasFocused: true, hadBox: true, press: { at: 0 } });
  c.areaKey = () => "chat:test";
  return c;
}
const cx = () => {
  const c: any = { stopped: 0, notify() {}, stop_propagation() { c.stopped++; }, timer: { after: (_ms: number, f: () => void) => f() } };
  return c;
};
const at = (x: number, y: number, count = 1) => ({ position: { x, y }, click_count: count });
// One press on the messages: the list's handler, then the chat's own (the root's, which sees every press).
const press = (c: any, x: number, y: number, count = 1) => { c.textDown(at(x, y, count)); c.textPressAnywhere(at(x, y, count)); };

describe("Ctrl+C on a highlight in the window's chat (SHEP-37)", () => {
  test("after a drag over a message the box leaves the keyboard with the highlight", () => {
    const c = chat();
    press(c, 100, 200);
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(0); // mid-drag too
    c.textUp(at(260, 230));
    c.refocus(true, true, cx());
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(0);
    expect(c.keepsText()).toBe(true);
  });

  test("a double click (a word highlighted) keeps it too", () => {
    const c = chat();
    press(c, 100, 200, 2);
    c.textUp(at(100, 200, 2));
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(0);
  });

  test("a plain click on the messages gives the box the keyboard back, as before", () => {
    const c = chat();
    press(c, 100, 200);
    c.textUp(at(100, 200));
    expect(c.textSel).toBe(null);
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(1);
  });

  test("the pane just focused by a drag on it: the box's own catch-up waits too", () => {
    const c = chat();
    c.wasFocused = false;
    press(c, 100, 200);
    c.textUp(at(300, 200));
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(0);
  });

  test("Ctrl+C, Cmd+C and other shortcuts pass by, untouched", () => {
    const c = chat();
    press(c, 100, 200);
    c.textUp(at(300, 200));
    for (const modifiers of [{ control: true }, { platform: true }, { control: true, shift: true }, { alt: true }]) {
      const k = cx();
      c.textKey({ key: "c", keystroke: "ctrl-c", modifiers }, k);
      expect(k.stopped).toBe(0);
    }
    c.textKey({ key: "shift", keystroke: "shift", modifiers: { shift: true } }, cx());
    expect(c.keepsText()).toBe(true);
    expect(c.box.focused).toBe(0);
  });

  test("typing after the highlight goes into the box", () => {
    const c = chat();
    press(c, 100, 200);
    c.textUp(at(300, 200));
    const k = cx();
    c.textKey({ key: "h", keystroke: "h", key_char: "h", modifiers: {} }, k);
    expect(c.box.focused).toBe(1);
    expect(c.box.typed).toEqual(["h"]);
    expect(k.stopped).toBe(1);
    expect(c.textSel).toBe(null);
  });

  test("Enter after a highlight only moves the keyboard to the box (nothing sent, no new line)", () => {
    const c = chat();
    press(c, 100, 200);
    c.textUp(at(300, 200));
    c.textKey({ key: "enter", keystroke: "enter", key_char: "\n", modifiers: {} }, cx());
    expect(c.box.focused).toBe(1);
    expect(c.box.typed).toEqual([]);
  });

  test("keys while the box has the keyboard are the box's own", () => {
    const c = chat();
    c.focused = true;
    const k = cx();
    c.textKey({ key: "h", keystroke: "h", key_char: "h", modifiers: {} }, k);
    expect(k.stopped).toBe(0);
    expect(c.box.typed).toEqual([]);
  });

  test("a press outside the messages ends the wait", () => {
    const c = chat();
    press(c, 100, 200);
    c.textUp(at(300, 200));
    c.textPressAnywhere(at(100, 700)); // the box, the header, the find bar
    expect(c.textSel).toBe(null);
    c.refocus(true, true, cx());
    expect(c.box.focused).toBe(1);
  });

  test("in a call or with Find open, keys aren't taken", () => {
    for (const set of [{ call: {} }, { finding: true }]) {
      const c = chat();
      press(c, 100, 200);
      c.textUp(at(300, 200));
      Object.assign(c, set);
      const k = cx();
      c.textKey({ key: "h", keystroke: "h", key_char: "h", modifiers: {} }, k);
      expect(k.stopped).toBe(0);
      expect(c.box.typed).toEqual([]);
    }
  });
});
