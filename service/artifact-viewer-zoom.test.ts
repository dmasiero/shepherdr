// The window's artifact viewer at Herdr's zoom (SHEP-53): at zoom 2.1 a recipe opened beside the chat took over most
// of the window, and zoomed out it was a small box floating mid-right, its pictures small inside boxes much wider than
// them. Where things are in the window (a press, an element's bounds) is in pixels at the zoom, while an overlay's size
// and the view's layout are at zoom 1: the viewer was opened at the chat pane's size in pixels (2.1x too big), over a
// place noted at another zoom, and a picture's box was the column's width by the picture's own height.
// No window runs here, so gpui and herdr are stand-ins that keep the handlers given.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, fakeGpuiBase, fakeGpuiKit, handler } from "./fake-gpui";

const ZOOMS = [1, 1.5, 2.1, 3];
let zoom = 1;
let viewerProps: any = {};
let store: Record<string, unknown> = {};
let paneList: any[] = [];
let focusedPane: any = null;
const opened: any[] = [];
const closed: string[] = [];
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom }), theme: () => theme, props: () => viewerProps,
  shared: (k: string) => store[k], setShared: (k: string, v: unknown) => { store[k] = v; },
  panes: () => paneList, focused: () => focusedPane, agents: () => [], terminals: () => [], spaces: () => [], machines: () => [],
  knownAgents: () => [], layout: () => null, window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async (_cmd: string, args: string[]) => (args.includes("pull")
    ? { code: 0, stdout: JSON.stringify({ mod: "art-x" }), stderr: "" }
    : { code: 0, stdout: JSON.stringify({ versions: [{ v: 1 }] }), stderr: "" }),
  hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
  openOverlay: (o: any) => { opened.push(o); return `ov${opened.length}`; }, closeOverlay: (id: string) => { closed.push(id); return null; },
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ROOT = join(import.meta.dir, "..");
const { viewerPlace, showViewer, noteChatArea, chatArea } = await import("../mods/artifacts/artview.js");
const { default: Chat } = await import("../mods/chat/main.js");
const { default: TaskArtifacts } = await import("../mods/task-artifacts/main.js");
const { default: ImageViewer } = await import("../mods/chat-image/main.js");

// An installed recipe artifact as herdr-artifact lays it out, with its pictures' sizes.
const dir = mkdtempSync(join(tmpdir(), "artifact-zoom-"));
copyFileSync(join(ROOT, "mods/artifacts/recipe-view.js"), join(dir, "recipe-view.js"));
copyFileSync(join(ROOT, "core/recipe.js"), join(dir, "recipe.js"));
writeFileSync(join(dir, "artifact.js"), "export const asset = (p) => p;\nexport async function reply() { return true; }\n");
const recipe = {
  recipe: 1, title: "Proof",
  blocks: [
    { type: "image", id: "wide", src: "wide.png", caption: "A wide screenshot" },
    { type: "image", id: "small", src: "./small.png" },
    { type: "pair", id: "pr", before: { src: "before.png" }, after: { src: "after.png" } },
    { type: "image", id: "unknown", src: "unknown.png" },
  ],
};
const SIZES = { "wide.png": [2560, 1600], "small.png": [400, 300], "before.png": [1280, 800], "after.png": [1280, 800] };
writeFileSync(join(dir, "recipe-data.js"), `export default ${JSON.stringify(recipe)};\nexport const sizes = ${JSON.stringify(SIZES)};\n`);
const { default: RecipeView } = await import(join(dir, "recipe-view.js"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tick = () => new Promise((r) => setTimeout(r, 0));
const cx: any = {
  notify: () => {}, stop_propagation: () => {}, focus_handle: () => ({ focus: () => {} }),
  spawn: (f: any) => f(cx), timer: { after: (_ms: number, f: any) => f(cx), every: () => {} },
};
// SHEP-50's proof beside a chat pane 870 x 560 (at zoom 1), its top left 504 x 40 in the window's pixels.
const PANE = { width: 870, height: 560 };
const ORIGIN = { x: 504, y: 40 };

beforeEach(() => { opened.length = 0; closed.length = 0; store = {}; zoom = 1; });

describe("where the viewer opens and how big (SHEP-53)", () => {
  for (const z of ZOOMS) {
    test(`over a pane noted at zoom ${z}: exactly that pane`, () => {
      zoom = z;
      showViewer({ mod: "art-x", id: "x", title: "Proof", version: 1, area: { ...ORIGIN, width: PANE.width * z, height: PANE.height * z, zoom: z } });
      const o = opened[0];
      // Its size at zoom 1 (drawn z times bigger: the pane's pixels); its top left where the pane's is.
      expect([o.width, o.height]).toEqual([PANE.width, PANE.height]);
      expect(o.at).toEqual(ORIGIN);
    });

    test(`a card in the chat at zoom ${z} opens it over that chat pane`, async () => {
      zoom = z;
      const c: any = Object.create(Chat.prototype);
      Object.assign(c, { ...PANE, machine: null });
      // A press 100 x 50 into the pane (zoom 1), as the window reports it: in pixels at the zoom.
      c.notePress({ local_position: { x: 100 * z, y: 50 * z } });
      c.pressWin = { x: ORIGIN.x + 100 * z, y: ORIGIN.y + 50 * z };
      c.openArtifact({ art: "x", title: "Proof", version: 1 });
      await tick(); await tick();
      expect(opened.length).toBe(1);
      expect([opened[0].width, opened[0].height]).toEqual([PANE.width, PANE.height]);
      expect(opened[0].at).toEqual(ORIGIN);
    });
  }

  test("a place noted at another zoom isn't used: the whole window instead", () => {
    zoom = 1.5;
    expect(viewerPlace({ ...ORIGIN, width: 870 * 2.1, height: 560 * 2.1, zoom: 2.1 })).toEqual({ width: 1, height: 1, at: { x: 0, y: 0 } });
    // noted before zooms were (no zoom): never trusted
    expect(viewerPlace({ ...ORIGIN, width: 870, height: 560 })).toEqual({ width: 1, height: 1, at: { x: 0, y: 0 } });
    expect(viewerPlace(null)).toEqual({ width: 1, height: 1, at: { x: 0, y: 0 } });
  });

  test("Ctrl+K's chat place is noted with its zoom and forgotten by another", () => {
    paneList = [{ pane: "p1", mod: "chat", tab: "t1" }];
    focusedPane = { pane: "p1", tab: "t1" };
    zoom = 2.1;
    noteChatArea("p1", { area: { ...ORIGIN, width: 1827, height: 1176 } });
    expect(chatArea()).toEqual({ ...ORIGIN, width: 1827, height: 1176, zoom: 2.1 });
    // Ctrl - with the pointer still: the noted place is from 2.1
    zoom = 1.5;
    expect(chatArea()).toBeNull();
    // a focus change alone doesn't make an old place new
    noteChatArea("p1", { focus: true, at: Date.now() });
    expect(chatArea()).toBeNull();
    noteChatArea("p1", { area: { ...ORIGIN, width: 1305, height: 840 } });
    expect(chatArea()?.zoom).toBe(1.5);
  });

  for (const z of ZOOMS) {
    test(`a task's Artifacts at zoom ${z} open it over that list's own place`, async () => {
      zoom = z;
      // a thread place from another zoom, stale
      store["chat.areas"] = { thread: { area: { x: 9, y: 9, width: 99, height: 99, zoom: z + 0.5 } } };
      const v: any = Object.create(TaskArtifacts.prototype);
      v.init({}, cx);
      built.length = 0;
      v.render(cx);
      const box = { x: 1500, y: 120, width: 380 * z, height: 600 * z };
      handler(byId("task-artifacts"), "on_mouse_down")!({ position: { x: 1600, y: 300 }, bounds: box }, cx);
      v.open({ id: "x", title: "Proof", v: 1 }, null, cx);
      await tick(); await tick();
      expect([opened[0].width, opened[0].height]).toEqual([380, 600]);
      expect(opened[0].at).toEqual({ x: 1500, y: 120 });
    });
  }

  test("zooming with the viewer open over a pane opens it again over the whole window", () => {
    zoom = 2.1;
    const area = { ...ORIGIN, width: 870 * 2.1, height: 560 * 2.1, zoom: 2.1 };
    viewerProps = { artifact: { mod: "art-x", base: "art-x", id: "x", title: "Proof", version: 1, latest: 1, area }, overlay: "ov-open" };
    const v: any = new ImageViewer();
    v.init({}, cx);
    built.length = 0;
    v.render(cx);
    const onSize = handler(byId("bar"), "on_size_change")!;
    onSize({ width: 870 * 2.1, height: 48 * 2.1 }, cx);
    expect(opened.length).toBe(0);
    zoom = 1.5;
    onSize({ width: 870 * 1.5, height: 48 * 1.5 }, cx);
    expect(closed).toEqual(["ov-open"]);
    expect(opened.length).toBe(1);
    expect([opened[0].width, opened[0].height, opened[0].at]).toEqual([1, 1, { x: 0, y: 0 }]);
    // once
    onSize({ width: 870 * 1.5, height: 48 * 1.5 }, cx);
    expect(opened.length).toBe(1);
    viewerProps = {};
  });
});

// A picture in the recipe: its box (the wrapper, measured) and the image in it.
function picture(key: string) {
  const box = byId(`pic-${key}`)!;
  const img = box.kids.find((k: any) => k.kind === "image");
  const arg = (n: string) => img.calls.filter(([c]: any) => c === n).map(([, a]: any) => a[0]).pop();
  return { box, img, w: arg("w"), h: arg("h"), full: img.calls.some(([c]: any) => c === "w_full") };
}

describe("a recipe's pictures fill their boxes at any zoom (SHEP-53)", () => {
  for (const z of ZOOMS) {
    test(`at zoom ${z}, in a column 828 wide`, () => {
      zoom = z;
      const v: any = Object.create(RecipeView.prototype);
      v.init();
      built.length = 0;
      v.render(cx);
      // The window reports each box's width in pixels at the zoom.
      for (const k of ["wide", "small", "pr-Before", "pr-After", "unknown"]) {
        const room = k.startsWith("pr-") ? 409 : 828;
        handler(byId(`pic-${k}`), "on_size_change")!({ width: room * z, height: 10 }, cx);
      }
      built.length = 0;
      v.render(cx);
      // Wider than its room: the room's width, and its own shape (the border's 2 px aside).
      const wide = picture("wide");
      expect(wide.w).toBe(828);
      expect((wide.w - 2) / (wide.h - 2)).toBeCloseTo(2560 / 1600, 2);
      // Smaller than its room: its own size, never stretched (its "./" path found too).
      const small = picture("small");
      expect([small.w, small.h]).toEqual([400, Math.round((398 * 300) / 400) + 2]);
      expect((small.w - 2) / (small.h - 2)).toBeCloseTo(400 / 300, 1);
      // A pair's halves: each its half's width.
      for (const k of ["pr-Before", "pr-After"]) {
        const p = picture(k);
        expect(p.w).toBe(409);
        expect((p.w - 2) / (p.h - 2)).toBeCloseTo(1280 / 800, 2);
      }
      // A picture of unknown size takes its room's width, as before.
      expect(picture("unknown").full).toBe(true);
    });
  }

  test("before its room is measured, the column's width (never past 860 less padding)", () => {
    zoom = 2.1;
    const v: any = Object.create(RecipeView.prototype);
    v.init();
    built.length = 0;
    v.render(cx);
    handler(byId("recipe"), "on_size_change")!({ width: 1400 * 2.1, height: 900 * 2.1 }, cx);
    built.length = 0;
    v.render(cx);
    expect(picture("wide").w).toBe(828);
  });
});
