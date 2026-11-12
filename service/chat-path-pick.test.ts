// The window's chat (mods/chat), SHEP-50: "@~/" in the box lists the folder typed so far on the agent's machine, and
// Tab, Up/Down, Enter and Escape move through it. No window runs here: gpui and herdr are stand-ins, exec answers
// LIST for a made-up home, and these drive the chat's own methods the box's keys call.
import { describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

// The composer's key handler, caught as it's drawn.
const keyDowns: ((e: any, cx: any) => void)[] = [];
function el(): any {
  const self: any = new Proxy({}, {
    get(_t, k) {
      if (k === "then") return undefined;
      if (k === "on_key_down") return (f: any) => { keyDowns.push(f); return self; };
      if (k === "when") return (c: unknown, f: (e: any) => any) => (c ? f(self) : self);
      return () => self;
    },
  });
  return self;
}
// The agent's machine's home: each folder's entries as LIST prints them.
const HOME: Record<string, string[]> = {
  "": ["dev/", "Documents/", "work-b/", "work-a/", ".config/", "notes.txt"],
  "dev/": ["shepherdr/", "shop/", "todo.md"],
  "dev/shepherdr/": ["core/", "README.md"],
  "dev/shepherdr/core/": ["mentions.js", "path-pick.js"],
};
const calls: { args: string[]; on: unknown }[] = [];
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  settings: () => ({ zoom: 1 }), theme: () => theme, shared: () => undefined, setShared: () => {}, agents: () => [], panes: () => [],
  terminals: () => [], spaces: () => [], machines: () => [], knownAgents: () => [], props: () => ({}), window: () => ({ platform: "linux" }),
  home: () => "/nonexistent-home", appHome: () => "/nonexistent-app",
  exec: async (_cmd: string, args: string[], opts: any) => {
    calls.push({ args, on: opts?.on });
    const got = HOME[args[3] ?? ""];
    return got ? { code: 0, stdout: got.join("\n") + "\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
  },
  hc: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => {},
}));
mock.module("gpui-kit", () => fakeGpuiKit({ View: class {}, div: el, svg: el, image: el }));
mock.module("gpui-base", () => fakeGpuiBase({ v_flex: el, h_flex: el, v_virtual_list: el, Scrollbar: el, TextView: { markdown: el } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Chat } = await import("../mods/chat/main.js");

const waits: Promise<unknown>[] = [];
const cx = (): any => ({ notify() {}, stop_propagation() {}, timer: { after: (_ms: number, f: () => void) => f() },
  spawn(f: (cx: any) => Promise<unknown>) { waits.push(f(cx())); } });
const settle = async () => { while (waits.length) await waits.shift(); };

function chat(machine: string | null = "vm-b") {
  const c: any = Object.create(Chat.prototype);
  let value = "";
  const box = { value: () => value, set_value(v: string) { value = v; }, focus() {} };
  Object.assign(c, { box, machine, dirs: new Map(), slashSel: 0, slashOff: null, cmds: [{ name: "help", about: "" }],
    reach: { spaces: [] }, tasks: [{ ref: "SHEP-4", folder: "/f", title: "A task", status: "work" }], spaceTasks: [], picked: [], pickedTasks: [] });
  c.saveSoon = () => {};
  // As the box's change handler: the folder typed so far is listed.
  c.type = async (v: string) => { value = v; c.slashSel = 0; const tp = (await import("../core/path-pick.js")).typingPath(v); if (tp) c.loadDir(tp.dir, cx()); await settle(); };
  c.names = () => c.suggestions().map((x: any) => x.name);
  return c;
}

describe('"@~/" in the window\'s box (SHEP-50)', () => {
  test("lists home on the agent's machine: folders first, no hidden ones, never the task list", async () => {
    const c = chat();
    await c.type("look at @~/");
    expect(calls.at(-1)).toEqual({ args: ["-c", expect.any(String), "x", ""], on: "vm-b" });
    expect(c.names()).toEqual(["dev/", "Documents/", "work-a/", "work-b/", "notes.txt"]);
    await c.type("look at @~/.");
    expect(c.names()).toEqual([".config/"]);
    // a plain @word still lists tasks
    await c.type("ask @SHEP");
    expect(c.suggestions().map((x: any) => x.name)).toEqual(["@SHEP-4"]);
  });

  test("Tab fills in the shared start, then takes the chosen; into a folder it stays open; a file goes in plain", async () => {
    const c = chat();
    await c.type("@~/w");
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("@~/work-");               // work-a/ and work-b/ share "work-"
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("@~/work-a/");             // nothing more shared: the chosen one
    await c.type("see @~/de");
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("see @~/dev/");
    expect(c.names()).toEqual(["shepherdr/", "shop/", "todo.md"]); // listed at once, still open
    await c.type("see @~/dev/s");
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("see @~/dev/sh");           // shepherdr/ and shop/ share "sh"
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("see @~/dev/shepherdr/");
    c.tabTake(c.suggestions(), 0, cx()); await settle();   // core/ first: a folder
    expect(c.box.value()).toBe("see @~/dev/shepherdr/core/");
    await c.type("see @~/dev/shepherdr/core/m");
    c.tabTake(c.suggestions(), 0, cx()); await settle();
    expect(c.box.value()).toBe("see ~/dev/shepherdr/core/mentions.js ");
    expect(c.suggestions()).toEqual([]);                   // closed
  });

  test("Down then Tab takes the chosen one, not the shared start; Enter takes it too", async () => {
    const c = chat();
    await c.type("@~/w");
    c.slashSel = 1;                                        // Down
    c.tabTake(c.suggestions(), c.slashSel, cx()); await settle();
    expect(c.box.value()).toBe("@~/work-b/");
    await c.type("@~/dev/");
    c.slashSel = 2;
    c.enter(cx(), false); await settle();
    expect(c.box.value()).toBe("~/dev/todo.md ");
  });

  test("Escape closes it for what's typed; typing on opens it again", async () => {
    const c = chat();
    await c.type("@~/dev/");
    expect(c.names().length).toBe(3);
    c.slashOff = c.box.value();                            // Escape (chat_slash_close)
    expect(c.suggestions()).toEqual([]);
    await c.type("@~/dev/s");
    expect(c.names()).toEqual(["shepherdr/", "shop/"]);
  });

  test("a folder that isn't there lists nothing; this machine's agent lists here", async () => {
    const c = chat(null);
    await c.type("@~/nope/");
    expect(calls.at(-1)?.on).toBe(null);
    expect(c.suggestions()).toEqual([]);
  });

  test("a / command still takes with Tab", async () => {
    const c = chat();
    await c.type("/he");
    c.tabTake(c.suggestions(), 0, cx());
    expect(c.box.value()).toBe("/help ");
  });

  test("the box's own keys: Tab, Down, Enter and Escape drive the list", async () => {
    const c = chat();
    Object.assign(c, { phase: "ready", focused: true, dict: { state: "idle" }, files: [], queue: [], asks: [], quote: null, recall: -1, addr: null });
    c.placeholder = () => ""; c.boxMeter = () => el(); c.tiles = () => null; c.status = () => "idle";
    const key = (k: string, m = {}) => { keyDowns.length = 0; c.composer(theme, "idle"); keyDowns.at(-1)!({ key: k, modifiers: m }, cx()); };
    await c.type("@~/de");
    key("tab"); await settle();
    expect(c.box.value()).toBe("@~/dev/");
    key("down");
    expect(c.slashSel).toBe(1);
    key("down");
    key("enter"); await settle();
    expect(c.box.value()).toBe("~/dev/todo.md ");
    await c.type("@~/dev/");
    key("escape");
    expect(c.suggestions()).toEqual([]);
  });
});
