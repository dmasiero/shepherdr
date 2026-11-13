// SHEP-57: the call button beside Search (and the rail's wave, and Ctrl+Shift+Space) did nothing. The shown space's
// Assistant chat pane had been saved with this computer's name in front of its terminal ("nextgate/t89", props
// { terminal }), which terminals() lists as "t89": the chat found no terminal, its own pane (myPane()) was null, and
// every call request, named for its pane, was for another chat. The whole way here: the brand row's button sets
// "voice.startreq", the Spaces sidebar passes it on as "chat.callreq" for the Assistant's pane, and the chat starts
// its call. gpui and herdr are stand-ins (no window).
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { byId, fakeGpuiBase, fakeGpuiKit, handler } from "./fake-gpui";

const shared = new Map<string, unknown>();
const ran: [string, unknown][] = [];
let coreName: string | null = null;
const stored = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); },
};

// This computer ("nextgate") runs the shepherdr space's Assistant as t89, parked behind its chat pane pd43; another
// machine (m3oracle) runs t5, parked behind a chat pane here too.
const terminals = () => [
  { address: "t89", state: "live", labels: { "herdr.chat": "pd43", "herdr.role": "coordinator" } },
  { address: "m3oracle/t5", state: "live", labels: { "herdr.chat": "pm5" } },
  { address: "t5", state: "live", labels: {} },
];
const panes = () => [
  { pane: "pd43", mod: "chat", tab: "tb1", terminal: null },
  { pane: "pm5", mod: "chat", tab: "tb2", terminal: null },
];
const spaces = () => [{ id: "sp1", name: "shepherdr", active: true, machine: null, folder: "/tmp/x", tabs: [{ id: "tb1", name: "Assistant", active: true }] }];
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  run: (c: string, a: unknown) => { ran.push([c, a]); }, props: () => ({}), theme: () => theme,
  window: () => ({ platform: "linux", fullscreen: false }), updates: () => ({ app: {} }), settings: () => ({}),
  layout: () => ({ id: "root", children: [{ id: "sidebar", size: { px: 268 } }] }),
  terminals, panes, spaces, agents: () => [], machines: () => [{ name: "m3oracle", layout: "ready" }],
  focused: () => ({ space: "sp1", tab: "tb1", pane: "pd43", terminal: null }), knownAgents: () => [],
  appHome: () => "/nonexistent-app", home: () => "/nonexistent-home",
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  hc: async (args: string[]) => (args[0] === "server" && coreName ? { code: 0, stdout: JSON.stringify({ core: { name: coreName } }), stderr: "" } : { code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => null, writeTextFile: async () => {}, watchFolder: () => new Promise(() => {}),
}));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase());

const { default: Chrome } = await import("../mods/workspace-chrome-shepherdr/main.js");
const { default: Spaces } = await import("../mods/spaces-chat/main.js");
const { default: Chat, ownAddr } = await import("../mods/chat/main.js");

// A chat made as init() makes it from props { terminal }, with only what the call path reads.
function chatFor(terminal: string) {
  const c: any = Object.create(Chat.prototype);
  c.origin = ownAddr(terminal);
  c.addr = c.origin;
  c.call = null;
  c.callReqAt = null;
  c.started = 0;
  c.toggleCall = () => { c.started++; };
  return c;
}
const cx: any = { timer: { after: (_ms: number, f: (cx: any) => void) => f(cx) }, notify: () => {} };

// The brand row's button, then the sidebar's poll (every 250 ms), then the chat's render.
function clickCall(chat: any) {
  new (Chrome as any)().render();
  handler(byId("voice"), "on_click")!();
  const sidebar: any = Object.create(Spaces.prototype);
  sidebar.voiceReqAt = null;
  sidebar.takeVoiceReq();
  chat.takeCallReq(chat.myPane(), cx);
}

describe("the call button starts the Assistant's call (SHEP-57)", () => {
  beforeEach(() => { shared.clear(); ran.length = 0; stored.clear(); coreName = null; });

  test("this computer's name learned after the chat was made: its pane is still found", async () => {
    // the window just started: no name yet, and the chat kept the address as saved
    const chat: any = chatFor("t89");
    chat.addr = "nextgate/t89";
    coreName = "nextgate";
    ownAddr("x/t1"); // asks herdr-core its name (the first ask in this file)
    await Bun.sleep(0);
    expect(ownAddr("nextgate/t89")).toBe("t89");
    expect(stored.get("chat.coreName")).toBe("nextgate");
    expect(chat.myPane()).toBe("pd43");
    clickCall(chat);
    expect(chat.started).toBe(1);
  });

  test("button -> voice.startreq -> chat.callreq for the Assistant's pane -> its chat starts the call", () => {
    const chat = chatFor("t89");
    clickCall(chat);
    expect((shared.get("voice.startreq") as any)?.at).toBeGreaterThan(0);
    expect(shared.get("chat.callreq")).toMatchObject({ pane: "pd43", action: "start" });
    expect(chat.started).toBe(1);
    // the same request again (the next render) starts nothing more
    chat.takeCallReq(chat.myPane(), cx);
    expect(chat.started).toBe(1);
  });

  test("a chat pane saved as \"<this computer>/t89\" is still t89's chat, and starts the call", () => {
    // before the window knows this computer's name: no machine Herdr knows, a terminal here a chat pane shows
    expect(ownAddr("nextgate/t89", null)).toBe("t89");
    const chat = chatFor("nextgate/t89");
    expect(chat.addr).toBe("t89");
    expect(chat.myPane()).toBe("pd43");
    clickCall(chat);
    expect(chat.started).toBe(1);
  });

  test("another machine's terminal stays that machine's, even with a terminal of the same id here", () => {
    expect(ownAddr("m3oracle/t5", null)).toBe("m3oracle/t5");
    expect(ownAddr("m3oracle/t5", "nextgate")).toBe("m3oracle/t5");
    expect(ownAddr("t89", null)).toBe("t89");
    // an unknown prefix for a terminal here no chat shows: left alone
    expect(ownAddr("gone/t5", null)).toBe("gone/t5");
  });

  test("a request for another chat's pane starts nothing here", () => {
    const chat = chatFor("t89");
    shared.set("chat.callreq", { pane: "pm5", at: Date.now(), action: "start" });
    chat.takeCallReq(chat.myPane(), cx);
    expect(chat.started).toBe(0);
  });
});
