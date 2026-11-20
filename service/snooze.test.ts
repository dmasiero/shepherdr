// fork: Snooze (SHEP-78): the service's side. The web's snooze action writes the shared "tasks.snoozed" (and Unsnooze,
// a message or an answer takes it away); each snapshot works out the wake (a new question, Ready, its time up), writes
// it back once and marks the task; a snoozed task is in no count and sends no alert; one back by its time sends one
// quiet "Back from snooze". All against a Compat with a stand-in shared document: no hub, no window, no agent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsYou } from "../web/shared/needs-you.ts";
import { waiting } from "../web/shared/alerts.ts";
import { attentionCounts } from "../web/src/attention.ts";
import { glanceOf } from "./glance.ts";
import { WHY } from "../core/snooze.js";

const APP = mkdtempSync(join(tmpdir(), "shep-snooze-"));
const was = process.env.HERDR_APP_HOME;
let act: typeof import("./actions.ts").act, Compat: typeof import("./compat.ts").Compat, alertsOf: typeof import("./push.ts").alertsOf;
beforeAll(async () => {
  process.env.HERDR_APP_HOME = APP;
  ({ act } = await import("./actions.ts"));
  ({ Compat } = await import("./compat.ts"));
  ({ alertsOf } = await import("./push.ts"));
});
afterAll(() => { if (was === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = was; });

const KEY = ":/srv/shop#4";
/** a Compat whose shared document is a plain object; writes are recorded */
function service(doc: Record<string, any> = {}) {
  const c = new Compat() as any;
  const writes: any[] = [];
  c.shared = { value: (k: string) => doc[k], set: async (k: string, v: unknown) => { writes.push({ k, v }); doc[k] = v; } };
  // the open question cards, as compat finds them through the hook's asks
  c.asks = { open: new Map<string, any>() };
  c.question = (a: any) => ({ id: a.id, title: "Which one?", kind: "Question", choices: [{ label: "A" }] });
  return { c, doc, writes, ask: (id: string) => c.asks.open.set(id, { id, terminal: "t5", at: 1 }) };
}
const row = (more: any = {}) => ({ key: KEY, section: "working", ref: "SHOP-4", machine: null, folder: "/srv/shop", slug: "shop", id: 4, title: "Coverage",
  worker: "t5", ready_at: null, agents: [], logs: [], ...more });
const snap = (c: any, ...rows: any[]) => c.snapshot({ host: "mini", user: "me", machines: [], spaces: [], sections: [], rows: rows.length ? rows : [row()] });
const ready = (s: any) => s.tasks.filter((t: any) => t.status === "ready" && !t.snoozedUntil).length;

test("the snooze action writes the shared key with the task's signature; Unsnooze takes it away", async () => {
  const { c, doc } = service();
  snap(c, row({ section: "ready", ready_at: 500 }));
  const r: any = await act({} as any, { type: "snooze", chat: "SHOP-4/worker", in: "3h" }, c);
  expect(r.ok).toBe(true);
  expect(doc["tasks.snoozed"][KEY]).toMatchObject({ until: r.until, seen: { status: "ready", cards: [], ready: 500 }, task: "shop#4" });
  expect(r.until - Date.now()).toBeGreaterThan(3 * 3600_000 - 5000);
  // a time it doesn't know: herdr-task's words, nothing written
  expect(await act({} as any, { type: "snooze", chat: "SHOP-4/worker", at: "someday" }, c)).toMatchObject({ ok: false, error: expect.stringMatching(/^Unknown time 'someday'/) });
  expect(await act({} as any, { type: "snooze", chat: "SHOP-4/worker", off: true }, c)).toEqual({ ok: true });
  expect(doc["tasks.snoozed"]).toEqual({});
  // a task not started can't be
  snap(c, row({ section: "todo" }));
  expect(await act({} as any, { type: "snooze", chat: "SHOP-4/worker", in: "3h" }, c)).toMatchObject({ ok: false });
});

test("writing to a snoozed task or answering it unsnoozes it", async () => {
  for (const b of [{ type: "send", chat: "SHOP-4/worker", text: "hi" }, { type: "answer", chat: "SHOP-4/worker", question: "q1", choice: 0 }, { type: "steer", chat: "SHOP-4/worker" }]) {
    const { c, doc } = service({ "tasks.snoozed": { [KEY]: { until: Date.now() + 3600_000, at: 1, seen: { status: "work", cards: [], ready: null } } } });
    snap(c);
    await act({ terminals: new Map(), send: async () => ({ code: 1 }) } as any, b, c).catch(() => null);
    await Bun.sleep(1);
    expect(doc["tasks.snoozed"]).toEqual({});
  }
});

test("a snoozed task is in no count and sends nothing; a new question wakes it and its alert goes", () => {
  const { c, doc, writes, ask } = service();
  ask("t5.100.1");
  const before = snap(c, row({ section: "needs" }));
  doc["tasks.snoozed"] = { [KEY]: { until: Date.now() + 3600_000, at: 1, seen: c.sigs.get(KEY), task: "shop#4" } };
  const s = snap(c, row({ section: "needs" }));
  const t = s.tasks[0];
  expect(t.snoozedUntil).toBeGreaterThan(Date.now());
  expect(needsYou(before).length).toBe(1);
  expect(needsYou(s)).toEqual([]);
  expect(waiting(s).count).toBe(0);
  expect(attentionCounts(s, [""]).need).toBe(0);
  const alerts = alertsOf(s);
  expect([...alerts.values()].every((a) => a.snoozed)).toBe(true);
  expect(glanceOf(s, alerts).counts).toEqual({ needs: 0, working: 0, ready: 0, done: 0 });
  expect(writes).toEqual([]);
  // the same question still showing: still snoozed; a new one: back, "Asked a question", its alert not snoozed
  ask("t5.200.1");
  const woke = snap(c, row({ section: "needs" }));
  expect(woke.tasks[0].snoozedUntil).toBeUndefined();
  expect(woke.tasks[0].woke).toBe(WHY.asked);
  expect(writes.length).toBe(1);
  expect(doc["tasks.snoozed"][KEY]).toMatchObject({ woke: WHY.asked });
  expect(alertsOf(woke).get("need:SHOP-4/worker:t5.200.1")?.snoozed).toBeUndefined();
  expect(needsYou(woke).length).toBe(1);
  // written once: the next snapshot finds it written
  snap(c, row({ section: "needs" }));
  expect(writes.length).toBe(1);
});

test("Ready wakes it; its Ready count leaves it out while snoozed", () => {
  const { c, doc } = service({ "tasks.snoozed": { [KEY]: { until: Date.now() + 3600_000, at: 1, seen: { status: "work", cards: [], ready: null } } } });
  const s = snap(c, row({ section: "ready", ready_at: 900 }));
  expect(s.tasks[0].woke).toBe(WHY.ready);
  expect(ready(s)).toBe(1);
  const { c: c2 } = service({ "tasks.snoozed": { [KEY]: { until: Date.now() + 3600_000, at: 1, seen: { status: "ready", cards: [], ready: 900 } } } });
  const s2 = snap(c2, row({ section: "ready", ready_at: 900 }));
  expect(s2.tasks[0].snoozedUntil).toBeDefined();
  expect(ready(s2)).toBe(0);
  expect(waiting(s2).count).toBe(0);
  expect(doc["tasks.snoozed"][KEY].woke).toBe(WHY.ready);
});

test("its time up: back with one quiet Back from snooze alert, sent once", async () => {
  const until = Date.now() + 30;
  const { c, doc } = service({ "tasks.snoozed": { [KEY]: { until, at: 1, seen: { status: "work", cards: [], ready: null } } } });
  expect(snap(c).tasks[0].snoozedUntil).toBe(until);
  await Bun.sleep(40);
  const s = snap(c);
  expect(s.tasks[0]).toMatchObject({ woke: WHY.time, wokeAt: until });
  expect(doc["tasks.snoozed"][KEY]).toEqual({ woke: WHY.time, at: until });
  const back = [...alertsOf(s).entries()].filter(([k]) => k.startsWith("woke:"));
  expect(back).toEqual([[`woke:SHOP-4:${until}`, expect.objectContaining({ title: "SHOP-4 · Back from snooze", body: "Coverage", silent: true })]]);
  // the next snapshot gives the same key: sent once
  expect([...alertsOf(snap(c)).keys()].filter((k) => k.startsWith("woke:"))).toEqual([`woke:SHOP-4:${until}`]);
});

test("two services agree, and a task done drops its entry", () => {
  const entry = { until: Date.now() + 3600_000, at: 1, seen: { status: "work", cards: [], ready: null } };
  const a = service({ "tasks.snoozed": { [KEY]: { ...entry } } }), b = service({ "tasks.snoozed": { [KEY]: { ...entry } } });
  const sa = snap(a.c, row({ section: "ready", ready_at: 5 })), sb = snap(b.c, row({ section: "ready", ready_at: 5 }));
  expect(sa.tasks[0].woke).toBe(sb.tasks[0].woke);
  expect(Object.keys(a.doc["tasks.snoozed"])).toEqual(Object.keys(b.doc["tasks.snoozed"]));
  const d = service({ "tasks.snoozed": { [KEY]: { ...entry } } });
  snap(d.c, row({ section: "done", done_at: Date.now() }));
  expect(d.doc["tasks.snoozed"]).toEqual({});
});
