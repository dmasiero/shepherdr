// SHEP-54: the open sidebar's brand row (layouts/shepherdr.json's "brand" block) draws the voice call button beside
// Search, and the call's Mute and End on a call. It named Herdr's own workspace-chrome, which has none. The mod drawn
// here is the one the layout names, so a layout pointing elsewhere fails. gpui and herdr are stand-ins (no window).
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, fakeGpuiBase, fakeGpuiKit, handler } from "./fake-gpui";

const find = (n: any, id: string): any => (n?.id === id ? n : (n?.children ?? []).map((c: any) => find(c, id)).find(Boolean) ?? null);
const layoutFile = JSON.parse(readFileSync(new URL("../layouts/shepherdr.json", import.meta.url), "utf8"));
const brandMod = find(layoutFile, "brand")?.content?.mod;

const shared = new Map<string, unknown>();
let sidebarPx = 268;
let platform = "linux";
const ran: [string, unknown][] = [];
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  run: (c: string, a: unknown) => { ran.push([c, a]); }, props: () => ({}), theme: () => theme,
  window: () => ({ platform, fullscreen: false }), updates: () => ({ app: {} }), settings: () => ({}), spaces: () => [],
  layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: sidebarPx } }] }),
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());

const { default: Chrome } = await import(`../mods/${brandMod}/main.js`);
const draw = () => { built.length = 0; return new (Chrome as any)().render(); };
const ids = () => built.flatMap((e: any) => e.calls.filter(([n]: any) => n === "id").map(([, a]: any) => a[0]));

describe("the open sidebar's brand row (SHEP-54)", () => {
  beforeEach(() => { shared.clear(); ran.length = 0; sidebarPx = 268; platform = "linux"; });

  test("the layout's brand block is Shepherdr's chrome", () => {
    expect(brandMod).toBe("workspace-chrome-shepherdr");
  });

  test("voice call button, then Search, then the sidebar toggle", () => {
    draw();
    const order = ids().filter((i: string) => ["voice", "search", "sidebar-toggle"].includes(i));
    expect(order).toEqual(["voice", "search", "sidebar-toggle"]);
    handler(byId("voice"), "on_click")!();
    expect((shared.get("voice.startreq") as any)?.at).toBeGreaterThan(0);
    handler(byId("search"), "on_click")!();
    expect(ran).toContainEqual(["mod.open", { name: "jump" }]);
  });

  test("on a call: Mute and End in the button's place", () => {
    shared.set("chat.calls", { "p1": { beat: Date.now(), muted: false } });
    draw();
    expect(ids()).toContain("voice-call");
    expect(ids()).not.toContain("voice");
    handler(byId("voice-end"), "on_click")!();
    expect(shared.get("chat.callreq")).toMatchObject({ pane: "p1", action: "end" });
  });

  test("voice add-on off: no call button, Search stays", () => {
    shared.set("addons.off", ["voice"]);
    draw();
    expect(ids()).not.toContain("voice");
    expect(ids()).toContain("search");
  });

  test("macOS: room for the traffic lights; the rail keeps none of these", () => {
    platform = "macos";
    draw();
    expect(built.some((e: any) => e.calls.some(([n, a]: any) => n === "pl" && a[0] === 76))).toBe(true);
    sidebarPx = 76;
    draw();
    expect(ids().filter((i: string) => ["voice", "search", "sidebar-toggle"].includes(i))).toEqual([]);
  });
});
