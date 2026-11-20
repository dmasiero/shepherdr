// fork: Snooze (SHEP-78) in the window: the Tasks panel (mods/tasks) folds snoozed tasks into Snoozed at the bottom,
// greyed with a snooze bell and "Snoozed until …", out of every other group; a task back from a snooze says why; and
// the window's counts (lib/inbox.js items and ready, the red and green counts) leave a snoozed task's out.
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit, built, byId, handler } from "./fake-gpui";

const shared = new Map<string, unknown>();
const none = async () => ({ code: 1, stdout: "", stderr: "" });
const theme = new Proxy({}, { get: () => "#000000" });
const tree = {
  id: "root", children: [{ id: "tasks", children: [{ id: "tasks-list" }, { id: "tasks-thread", children: [
    { id: "tasks-thread-body", children: [{ id: "tasks-thread-chat" }, { id: "tasks-thread-term" }] },
  ] }] }],
};
// task 1 works, task 2's agent asks (blocked), task 3 is Ready, task 4 works
const terms = [
  { address: "t1", state: "live", status: "working", labels: { "herdr.task": "shop#1" }, program: { key: "claude" } },
  { address: "t2", state: "live", status: "blocked", labels: { "herdr.task": "shop#2" }, program: { key: "claude" } },
  { address: "t4", state: "live", status: "working", labels: { "herdr.task": "shop#4" }, program: { key: "claude" } },
];
mock.module("herdr", () => fakeHerdr({
  run: () => {}, layout: () => tree, machines: () => [],
  exec: none, hc: none, theme: () => theme, appHome: () => "/nonexistent-app", home: () => "/nonexistent-home",
  readTextFile: async () => null, watchFolder: () => {}, nextCommand: () => new Promise(() => {}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  agents: () => [], panes: () => [], terminals: () => terms, spaces: () => [],
}));
const inert = (): any => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "value" ? () => "" : () => undefined) });
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase({ InputState: { new: inert } }));
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };

const { default: Tasks } = await import("../mods/tasks/main.js");
const { items, ready } = await import("../mods/tasks/inbox.js");
const cx: any = new Proxy({ timer: { every: () => {}, after: () => {} } }, { get: (t, k) => (t as any)[k] ?? (() => {}) });

const HOUR = 3600_000;
const tasks = [
  { id: 1, title: "Snoozed worker", state: "running", agents: [] },
  { id: 2, title: "Snoozed asker", state: "running", agents: [] },
  { id: 3, title: "Back from snooze", state: "ready", status: "ready", ready_at: 5, agents: [] },
  { id: 4, title: "Plain worker", state: "running", agents: [] },
];
const key = (id: number) => `:/tmp/shop#${id}`;
const panel = () => {
  const p: any = new Tasks();
  p.init({}, cx);
  p.lists = [{ machine: null, folder: "/tmp/shop", slug: "shop", prefix: "SHOP", name: "shop", tasks, automations: [] }];
  return p;
};
// every word an element shows, it and all under it
const words = (e: any): string[] => (typeof e === "string" ? [e] : !e?.kids ? [] : e.kids.flatMap(words));
const render = (p: any) => { built.length = 0; p.render(cx); };

beforeEach(() => {
  shared.clear();
  store.clear();
  shared.set("tasks.group", "status");
  shared.set("tasks.snoozed", {
    [key(1)]: { until: Date.now() + 3 * HOUR, at: 1, seen: { status: "work", cards: [], ready: null }, task: "shop#1" },
    [key(2)]: { until: Date.now() + 2 * HOUR, at: 1, seen: { status: "need", cards: [], ready: null }, task: "shop#2" },
    [key(3)]: { woke: "Time's up", at: 1 },
  });
});

for (const group of ["status", "you", "space"]) {
  test(`Snoozed is folded at the bottom, its tasks in no other group (grouped by ${group})`, () => {
    shared.set("tasks.group", group);
    const p = panel();
    render(p);
    const head = byId("head-snoozed");
    expect(head).toBeDefined();
    expect(words(head)).toEqual(["Snoozed", "2"]);
    // folded: none of its rows, and neither snoozed task anywhere else
    expect(byId(`task-${key(1)}`)).toBeUndefined();
    expect(byId(`task-${key(2)}`)).toBeUndefined();
    expect(byId(`task-${key(4)}`)).toBeDefined();
    // a click opens it: its rows, soonest back first, greyed with the snooze bell and until when
    handler(head!, "on_click")!({}, cx);
    render(p);
    const rows = built.filter((e: any) => e.calls.some(([n, a]: any) => n === "id" && /^task-:\/tmp\/shop#[12]$/.test(a[0])));
    expect(rows.map((e: any) => e.calls.find(([n]: any) => n === "id")[1][0])).toEqual([`task-${key(2)}`, `task-${key(1)}`]);
    const one = words(byId(`task-${key(1)}`));
    expect(one).toContain("Snoozed worker");
    expect(one.some((w) => /^Snoozed until (Today|Tomorrow) \d+:\d\d$/.test(w))).toBe(true);
    expect(built.some((e: any) => e.kind === "svg" || e.calls.some(([, a]: any) => a[0] === "mods/tasks/snooze.svg"))).toBe(true);
  });
}

test("a task back from a snooze says why on its line", () => {
  const p = panel();
  render(p);
  expect(words(byId(`task-${key(3)}`))).toContain("Back from snooze · Time's up");
});

test("a snoozed task's asks and waits are in none of the window's counts; its time up, they are again", () => {
  shared.set("inbox.tasks", [{ kind: "merge", machine: null, folder: "/tmp/shop", ref: "SHOP-1" }, { kind: "merge", machine: null, folder: "/tmp/shop", ref: "SHOP-3" }]);
  shared.set("inbox.asks", [{ id: "t2.100.1", terminal: "t2" }]);
  expect(items().map((x: any) => x.key)).toEqual([]);
  expect(ready().map((x: any) => x.ref)).toEqual(["SHOP-3"]);
  shared.set("tasks.snoozed", { [key(2)]: { until: Date.now() - 1, at: 1, seen: {}, task: "shop#2" } });
  expect(items().map((x: any) => x.key)).toEqual(["ask:t2.100.1"]);
  expect(ready().map((x: any) => x.ref)).toEqual(["SHOP-1", "SHOP-3"]);
});

test("opening a snoozed task from Snoozed takes its snooze away", () => {
  store.set("shut", JSON.stringify(["snoozed:open"]));
  const q = panel();
  render(q);
  const row = byId(`task-${key(1)}`);
  expect(row).toBeDefined();
  handler(row!, "on_click")!({}, cx);
  expect((shared.get("tasks.snoozed") as any)[key(1)]).toBeUndefined();
  expect((shared.get("tasks.snoozed") as any)[key(2)]).toBeDefined();
});
