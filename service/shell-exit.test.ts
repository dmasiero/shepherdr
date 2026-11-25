// fork: Ctrl+D closes the terminal. Your own shell's bridge tells the page it ended, so the page closes it instead of
// reconnecting into a fresh shell; a dropped link or an agent's terminal says nothing. The close reasons are herdr-core's
// own (seen on a throwaway core 0.1.22: Ctrl+D in fish, then terminal.kill).
import { expect, test } from "bun:test";
import { Hub } from "./hub.ts";
import { endedBy, terminalBridge } from "./terminal.ts";

const EXITED = { exit_code: 0, finished_ms: 1795580927534, reason: "exited", signal: null };
const KILLED = { exit_code: null, finished_ms: 1795580936605, reason: "killed", signal: 1 };
const DROPPED = { reason: "disconnected" };

function bridge(own: boolean) {
  const hub = new Hub("hc");
  const live = { address: "t1", state: "live", pid: 7, cols: 80, rows: 24 };
  (hub as any).terminals = new Map([["t1", live]]);
  (hub as any).up = true;
  const streams: { close(reason: unknown): void; observe: boolean }[] = [];
  (hub as any).client = {
    attach: async (_t: string, receive: any, _c: number, _r: number, options: { observe?: boolean } = {}) => {
      streams.push({ close: (r) => receive.close(r), observe: !!options.observe });
      return { input() {}, resize() {}, close() {} };
    },
    call: async () => ({}),
  };
  const sent: any[] = [];
  let closed = false;
  const ws = { send: (d: string | Uint8Array) => { if (typeof d === "string") sent.push(JSON.parse(d)); }, close() { closed = true; }, buffered: () => 0 };
  const b = terminalBridge(hub, "t1", ws as any, own);
  b.message(JSON.stringify({ type: "open", id: 1 }));
  const opened = async () => { while (!sent.some((m) => m.type === "ack")) await Bun.sleep(1); };
  const watching = () => streams.filter((s) => s.observe).at(-1)!;
  return { hub, live, sent, opened, watching, closed: () => closed, said: () => sent.map((m) => m.type) };
}

test("the reasons herdr-core gives: an ended terminal says when it finished, a dropped link doesn't", () => {
  expect(endedBy(EXITED)).toBe(true);
  expect(endedBy(KILLED)).toBe(true);
  expect(endedBy(DROPPED)).toBe(false);
  expect(endedBy(null)).toBe(false);
  expect(endedBy(new Error("x"))).toBe(false);
});

test("your own shell that exits tells the page it ended, then closes", async () => {
  for (const why of [EXITED, KILLED]) {
    const t = bridge(true);
    await t.opened();
    t.watching().close(why);
    expect(t.said()).toEqual(["size", "ack", "exited"]);
    expect(t.closed()).toBe(true);
  }
});

test("your own shell already marked finished when its stream goes counts too", async () => {
  const t = bridge(true);
  await t.opened();
  (t.hub as any).terminals.set("t1", { ...t.live, state: "finished" });
  t.watching().close(null);
  expect(t.said()).toContain("exited");
});

test("a dropped link is no exit: the page only sees the socket close, and reconnects to the same shell", async () => {
  const t = bridge(true);
  await t.opened();
  t.watching().close(DROPPED);
  expect(t.said()).not.toContain("exited");
  expect(t.closed()).toBe(true);
  // the hub itself down (a stopped core, a service going away): no exit either
  const u = bridge(true);
  await u.opened();
  (u.hub as any).up = false;
  u.watching().close(EXITED);
  expect(u.said()).not.toContain("exited");
});

test("an agent's terminal never says exited, even when its program ends", async () => {
  const t = bridge(false);
  await t.opened();
  t.watching().close(EXITED);
  expect(t.said()).not.toContain("exited");
  expect(t.closed()).toBe(true);
});
