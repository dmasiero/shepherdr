// fork: with a Herdr window on each of two machines, both show the second machine's spaces and both run the parked
// agents' sweep (lib/parked.js). An Assistant's herdr.chat label spells its chat pane as the window that started it
// does ("p…" on the pane's machine, "m3oracle/p…" elsewhere), and each window's sweep took the other's spelling for
// a gone pane and ended the agent within 10 s (SHEP-7). lib/parked.js imports "herdr": a fake window stands in.
import { beforeEach, expect, mock, test } from "bun:test";

let win = { panes: [], terminals: [] };
const killed = [];
mock.module("herdr", () => ({
  agents: () => [], spaces: () => [], panes: () => win.panes, terminals: () => win.terminals,
  machines: () => [{ name: null, layout: "ready" }, { name: "m3oracle", layout: "ready" }],
  focused: () => null, shared: () => null, setShared: () => {}, appHome: () => "/nowhere", home: () => "/nowhere", readTextFile: async () => null,
  run: (name, args) => { if (name === "terminal.kill") killed.push(args.terminal); },
  exec: async () => ({ stdout: "", code: 0 }), hc: async () => ({ stdout: "{}", code: 0 }),
}));
const { sweep, chatAgents } = await import("../lib/parked.js");
const { chatPaneOf } = await import("../lib/live.js");

const agent = (address, chat) => ({ address, state: "live", keep: true, labels: { "herdr.chat": chat } });
const sweepTwice = () => { sweep(); sweep(); };
beforeEach(() => { killed.length = 0; });

test("m3oracle's own window keeps an Assistant nextgate's window started (label m3oracle/p…)", () => {
  win = { panes: [{ pane: "p53f4", tab: "tb1", mod: "chat" }], terminals: [agent("t1q", "m3oracle/p53f4")] };
  sweepTwice();
  expect(killed).toEqual([]);
  expect(chatAgents().map((a) => [a.address, a.pane])).toEqual([["t1q", "p53f4"]]);
  expect(chatPaneOf(win.terminals[0])).toBe("p53f4");
});

test("nextgate's window keeps an Assistant m3oracle's window started (label p…)", () => {
  win = { panes: [{ pane: "m3oracle/p5031", tab: "m3oracle/tb1", mod: "chat" }], terminals: [agent("m3oracle/t1c", "p5031")] };
  sweepTwice();
  expect(killed).toEqual([]);
  expect(chatAgents().map((a) => a.pane)).toEqual(["m3oracle/p5031"]);
});

test("an agent whose chat pane is gone still ends, on the second miss", () => {
  win = { panes: [{ pane: "m3oracle/p9", tab: "m3oracle/tb1", mod: "chat" }], terminals: [agent("m3oracle/t7", "p0"), agent("t8", "pgone")] };
  sweep();
  expect(killed).toEqual([]);
  sweep();
  expect(killed.sort()).toEqual(["m3oracle/t7", "t8"]);
});

test("the same bare pane id on another machine isn't taken for it", () => {
  win = { panes: [{ pane: "vm/p1", tab: "vm/tb1", mod: "chat" }], terminals: [agent("m3oracle/t2", "p1")] };
  sweepTwice();
  expect(killed).toEqual(["m3oracle/t2"]);
});
