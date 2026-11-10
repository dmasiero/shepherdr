// The window's image viewer (mods/chat-image) with Herdr zoomed in (SHEP-42): its toolbar showed but no picture at
// zoom 2.3. An overlay's size is at zoom 1, while the window reports sizes and presses in pixels at the zoom. The chat
// opened the viewer at its pane's size times the zoom (an overlay 2.3x too big, cut at the window's edge), and the viewer
// laid out by the size the window reported: its stage 2.3x too big, the picture centred off-screen.
// No window runs here, so gpui and herdr are stand-ins that keep the handlers given.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

let zoom = 1;
let viewerProps: any = {};
const opened: any[] = [];
const handlers: Record<string, ((...a: any[]) => void)[]> = {};
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      if (k === "on_size_change") return (f: any) => { (handlers.size ??= []).push(f); return self; };
      return () => self;
    },
  });
  return self;
}
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => viewerProps,
  window: () => ({ platform: "linux" }), home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }), hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
  openOverlay: (o: any) => { opened.push(o); return "ov1"; }, closeOverlay: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: el } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");
const { default: ImageViewer } = await import("../mods/chat-image/main.js");
const cx: any = { notify: () => {}, focus_handle: () => ({ focus: () => {} }), timer: { after: () => {} }, spawn: () => {}, stop_propagation: () => {} };

// SHEP-41's picture in a chat pane 870 x 560 at zoom 1, as on nextgate.
const PANE = { width: 870, height: 560 };
const PIC = { rel: "data/chat-attach/view/1-desktop2.png", w: 1280, h: 800, name: "desktop2.png", path: "/x/desktop2.png" };

describe("the image viewer at Herdr's zoom (SHEP-42)", () => {
  beforeEach(() => { opened.length = 0; for (const k of Object.keys(handlers)) delete handlers[k]; });

  for (const z of [1, 2.3]) {
    test(`the chat opens it at the pane's size at zoom ${z}`, () => {
      zoom = z;
      const c: any = Object.create(Chat.prototype);
      Object.assign(c, { ...PANE, views: { "/x/desktop2.png": PIC } });
      c.openImages(["/x/desktop2.png"], 0);
      expect(opened.length).toBe(1);
      const o = opened[0];
      expect([o.width, o.height]).toEqual([PANE.width, PANE.height]);
      expect([o.props.width, o.props.height]).toEqual([PANE.width, PANE.height]);
    });

    test(`the picture is fitted inside the visible stage at zoom ${z}`, () => {
      zoom = z;
      viewerProps = { images: [PIC], index: 0, ...PANE };
      const v: any = new ImageViewer();
      v.init({}, cx);
      v.render();
      // The window reports the viewer's size in pixels at the zoom.
      handlers.size[0]({ width: PANE.width * z, height: PANE.height * z }, cx);
      const s = v.stage(), r = v.rect();
      expect(s).toEqual({ w: PANE.width, h: PANE.height - 48 });
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.w).toBeLessThanOrEqual(s.w);
      expect(r.top + r.h).toBeLessThanOrEqual(s.h);
      // Fitted in 870 - 2 x 24 by 512 - 2 x 24 of room, so below 100%.
      expect(v.fitScale()).toBeCloseTo(Math.min((PANE.width - 48) / PIC.w, (PANE.height - 48 - 48) / PIC.h));
    });

    test(`a double-click on the picture's middle zooms it at zoom ${z}`, () => {
      zoom = z;
      viewerProps = { images: [PIC], index: 0, ...PANE };
      const v: any = new ImageViewer();
      v.init({}, cx);
      v.render();
      handlers.size[0]({ width: PANE.width * z, height: PANE.height * z }, cx);
      const r = v.rect();
      // Where the window says the press was: the picture's middle, in pixels at the zoom.
      const at = { x: (r.left + r.w / 2) * z, y: (r.top + r.h / 2) * z };
      v.down({ local_position: at, position: at, click_count: 2 }, cx);
      expect(v.fit).toBe(false);
      expect(v.scale).toBe(1);
    });
  }
});
