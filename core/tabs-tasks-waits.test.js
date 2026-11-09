// fork: the tab bar's two endless waits (SHEP-9). Its command loop (nextCommand, every 5 s) and the inbox engine's
// watch of data/chat-asks/req (every 4 s) each raced the same pending promise round after round, and every race
// left a listener on it until a command or a request came: about 6,500 promise records in 4 quiet hours. The real
// mod runs here in a fake window on a virtual clock (lib/inbox.js is its inbox.js), and Bun counts the promises.
// Bun shares module mocks across test files (parked-sweep's "herdr", emoji-grid's "gpui-kit" lack what the tab bar
// imports), so the tests run in a bun test of this file alone, with mocks of their own.
import { expect, mock, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { fakeHerdr } from "../service/fake-herdr.ts";
import { dirname } from "node:path";

if (!process.env.SHEP_TABS_WAITS) {
  test("the tab bar's waits, in a bun test of their own", () => {
    const r = Bun.spawnSync([process.execPath, "test", import.meta.path], {
      cwd: dirname(import.meta.dir), env: { ...process.env, SHEP_TABS_WAITS: "1" }, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    if (r.exitCode !== 0) console.log(out);
    expect(r.exitCode).toBe(0);
    expect(out).toContain(" 2 pass");
  }, 120_000);
} else {
  let now = 1_800_000_000_000;
  const realNow = Date.now;
  const sleepers = [];
  const cx = {
    timer: { every: () => {}, after: () => {} },
    spawn: (fn) => { Promise.resolve().then(() => fn(cx)).catch(() => {}); },
    sleep: (ms) => new Promise((resolve) => sleepers.push({ at: now + ms, resolve })),
    notify: () => {}, stop_propagation: () => {},
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await null; };
  // Runs the clock on by ms, waking each sleep in turn.
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      sleepers.sort((a, b) => a.at - b.at);
      if (!sleepers.length || sleepers[0].at > until) break;
      const s = sleepers.shift();
      now = Math.max(now, s.at);
      s.resolve();
      await settle();
    }
    now = until;
    await settle();
  }

  let command = null, watch = null;
  const overlays = [], execs = [];
  // Bun keeps one mocked module per name for the whole `bun test` run: every name another file's stand-in has (fakeHerdr's,
  // the gpui ones service/spaces-sidebar.test.ts gives) is here too, or that file's import fails.
  mock.module("herdr", () => fakeHerdr({
    agents: () => [], panes: () => [], terminals: () => [], machines: () => [{ name: null, layout: "ready" }],
    spaces: () => [{ id: "sp1", name: "one", active: true, tabs: [{ id: "tb1", active: true }] }],
    focused: () => null, shared: () => undefined, setShared: () => {}, appHome: () => "/nowhere", home: () => "/nowhere",
    run: () => {}, openOverlay: (o) => overlays.push(o), notify: () => {}, playSound: () => {},
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; },
    hc: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    readTextFile: async () => null, writeTextFile: async () => {},
    // Neither settles until the test says so, as in a quiet window.
    watchFolder: () => new Promise((resolve) => { watch = resolve; }),
    nextCommand: () => new Promise((resolve) => { command = resolve; }),
    theme: () => ({}), settings: () => ({ zoom: 1 }), window: () => ({}), layout: () => ({}),
  }));
  const el = () => new Proxy(function () {}, { get: (_t, p) => (p === "then" ? undefined : () => el()) });
  mock.module("gpui-kit", () => ({ View: class {}, div: el, svg: el, image: el }));
  mock.module("gpui-base", () => ({ h_flex: el, v_flex: el, Input: el, InputState: class {}, VirtualListScrollHandle: class {}, v_virtual_list: el, Scrollbar: el }));
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };

  Date.now = () => now;
  const { default: Tabs } = await import("../mods/tabs-tasks/main.js");
  const promises = () => { Bun.gc(true); return heapStats().objectTypeCounts.Promise ?? 0; };

  test("four quiet hours of waiting leave no pile of promises behind", async () => {
    try {
      new Tabs().init({}, cx);
      await advance(60_000);
      const before = promises();
      await advance(4 * 3600_000);
      // a race per wait: ~2,900 nextCommand rounds and ~3,600 watch rounds; one listener each now, whatever the time
      expect(promises() - before).toBeLessThan(200);
    } finally { Date.now = realNow; }
  }, 60_000);

  test("a command and a request still wake their loops at once", async () => {
    Date.now = () => now;
    try {
      command("rename-space");
      await settle();
      expect(overlays.at(-1)).toMatchObject({ mod: "spaces-chat", props: { view: "rename", space: "sp1" } });
      // a request lands: the inbox reads the asks again before its 4 s are up
      const reads = execs.length;
      watch();
      await settle();
      expect(execs.length).toBeGreaterThan(reads);
    } finally { Date.now = realNow; }
  });
}
