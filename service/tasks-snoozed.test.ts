// fork: Snooze (SHEP-78) in the window: the Tasks panel (mods/tasks) folds snoozed tasks into Snoozed just above Done,
// greyed with a snooze bell and "Snoozed until …", out of every other group; a task back from a snooze says why; and
// the window's counts (lib/inbox.js items and ready, the red and green counts) leave a snoozed task's out.
// fork: Same as last (SHEP-80): a row's menu (mods/tasks rowMenu, drawn by mods/tasks-menu) offers the last snooze's
// moment first, snoozes to it and keeps every snooze's moment in shared "tasks.lastSnooze".
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit, built, byId, handler } from "./fake-gpui";

const shared = new Map<string, unknown>();
const overlays: any[] = [];
let menuProps: any = null;
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
  openOverlay: (o: any) => { overlays.push(o); }, props: () => menuProps, closeOverlay: () => {},
}));
const inert = (): any => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "value" ? () => "" : () => undefined) });
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase({ InputState: { new: inert } }));
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };

const { default: Tasks } = await import("../mods/tasks/main.js");
const { items, ready } = await import("../mods/tasks/inbox.js");
const { default: TasksMenu } = await import("../mods/tasks-menu/main.js");
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
  test(`Snoozed is folded above Done, its tasks in no other group (grouped by ${group})`, () => {
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

// fork: SHEP-82: Snoozed sits just above Done (by status and For you); by space Done is inside each space's group, so
// Snoozed comes after them, before Automations
const idOf = (e: any) => e.calls.find(([n]: any) => n === "id")?.[1][0];
for (const group of ["status", "you", "space"]) {
  test(`Snoozed comes right above Done (grouped by ${group})`, () => {
    shared.set("tasks.group", group);
    const p = panel();
    p.lists[0].tasks = [...tasks, { id: 5, title: "Finished", state: "done", status: "done", agents: [] }];
    render(p);
    const ids = built.map(idOf);
    const snoozed = ids.indexOf("head-snoozed");
    expect(snoozed).toBeGreaterThanOrEqual(0);
    const heads = ids.filter((id: any) => /^head-(?!.*-label$)/.test(id ?? ""));
    if (group === "space") expect(heads.at(-1)).toBe("head-snoozed");
    else {
      // Done: a group by status, a quiet count line for you
      const done = ids.findIndex((id: any) => id === "head-done" || id === "task-done-line");
      expect(done).toBeGreaterThan(snoozed);
    }
  });
}

test("a task back from a snooze by its time says only Back from snooze (SHEP-81)", () => {
  const p = panel();
  render(p);
  const line = words(byId(`task-${key(3)}`));
  expect(line).toContain("Back from snooze");
  expect(line.some((w) => w.includes("Time's up"))).toBe(false);
});

test("a task back from a snooze by an event says why on its line", () => {
  for (const why of ["Asked a question", "Blocked", "Ready"]) {
    shared.set("tasks.snoozed", { [key(3)]: { woke: why, at: 1 } });
    const p = panel();
    render(p);
    expect(words(byId(`task-${key(3)}`))).toContain(`Back from snooze · ${why}`);
  }
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

// fork: Same as last (SHEP-80)
const menuOf = (pin: any) => {
  overlays.length = 0;
  panel().rowMenu({ key: key(4), on: false, status: "working", machine: null, folder: "/tmp/shop", ref: "SHOP-4", sub: null, snoozed: false, until: null,
    snooze: { seen: { status: "working", cards: [], ready: null }, task: "shop#4" }, ...pin });
  menuProps = overlays[0].props;
  const m: any = new TasksMenu();
  m.init({}, { ...cx, focus_handle: () => ({ focus: () => {} }) });
  built.length = 0;
  m.render(cx);
  return { m, height: overlays[0].height, shown: words(byId("tasks-menu")) };
};

test("a row's menu offers the last snooze's moment first; picking it snoozes to that very moment", () => {
  const plain = menuOf({}).height;
  // none yet: the menu as before
  expect(menuOf({}).shown).not.toContain("Same as last");
  const until = new Date(Date.now() + 26 * HOUR).setSeconds(0, 0) + 17 * 60000;
  shared.set("tasks.lastSnooze", { until, at: Date.now() - 60000 });
  const { shown, height } = menuOf({});
  const words_ = shown.filter((w) => w.startsWith("Same as last"));
  expect(words_.length).toBe(1);
  expect(words_[0]).toMatch(/^Same as last · (Tomorrow|Mon|Tue|Wed|Thu|Fri|Sat|Sun|[A-Z][a-z]{2} \d+) \d+:\d\d$/);
  // first under the Snooze heading, the popup one row taller
  expect(shown.slice(shown.indexOf("Snooze"), shown.indexOf("Snooze") + 3)).toEqual(["Snooze", words_[0], "In 3 hours"]);
  expect(height).toBe(plain + 32);
  // picked: snoozed to that moment, not a span from now; it stays the last
  handler(byId("tm-snooze-last:0")!, "on_click")!({}, cx);
  expect((shared.get("tasks.snoozed") as any)[key(4)]).toMatchObject({ until, task: "shop#4" });
  expect((shared.get("tasks.lastSnooze") as any).until).toBe(until);
});

test("a snoozed task's Change snooze time offers it too; past, it's gone; any pick becomes the last", () => {
  const until = Date.now() + 5 * HOUR;
  shared.set("tasks.lastSnooze", { until, at: 1 });
  const changing = menuOf({ snoozed: true, until: "Tomorrow 9:00" }).shown;
  expect(changing.slice(changing.findIndex((w) => w.startsWith("Change snooze time")), -1)[1]).toMatch(/^Same as last · /);
  shared.set("tasks.lastSnooze", { until: Date.now() - 1000, at: 1 });
  expect(menuOf({}).shown.some((w) => w.startsWith("Same as last"))).toBe(false);
  // In 3 hours picked: its moment is the last now, offered on the next task
  const before = Date.now();
  handler(byId("tm-snooze:0")!, "on_click")!({}, cx);
  const last: any = shared.get("tasks.lastSnooze");
  expect(last.until).toBe((shared.get("tasks.snoozed") as any)[key(4)].until);
  expect(last.until - before).toBeGreaterThanOrEqual(3 * HOUR);
  expect(last.until - before).toBeLessThan(3 * HOUR + 5000);
});

// fork: SHEP-84: For you's shut Done is a heading like the others ("Done 2", as "Snoozed 2"), not a quiet "2 done"
test("For you's shut Done reads Done and its count, as the other headings; a click opens it", () => {
  shared.set("tasks.group", "you");
  const p = panel();
  const old = Date.UTC(2020, 0, 1) / 1000;
  p.lists[0].tasks = [...tasks,
    { id: 5, title: "Finished", state: "done", status: "done", done_at: old, agents: [] },
    { id: 6, title: "Finished too", state: "done", status: "done", done_at: Math.floor(Date.now() / 1000), agents: [] }];
  render(p);
  const line = byId("task-done-line");
  expect(line).toBeDefined();
  expect(words(line)).toEqual(["Done", "2"]);
  // the same build as Snoozed's heading: chevron, label, count
  const shape = (e: any) => e.calls.map(([n]: any) => n).filter((n: string) => n !== "id" && n !== "on_click" && n !== "on_hover");
  expect(shape(line)).toEqual(shape(byId("head-snoozed")));
  handler(line!, "on_click")!({}, cx);
  render(p);
  expect(byId("task-done-line")).toBeUndefined();
  expect(words(byId("head-done"))).toEqual(["Done", "2"]);
  expect(byId(`task-${key(5)}`)).toBeDefined();
});

test("For you's shut Done, all from today, says so as a heading's note: Done · today 1", () => {
  shared.set("tasks.group", "you");
  const p = panel();
  p.lists[0].tasks = [...tasks, { id: 6, title: "Finished", state: "done", status: "done", done_at: Math.floor(Date.now() / 1000), agents: [] }];
  render(p);
  expect(words(byId("task-done-line"))).toEqual(["Done", "· today", "1"]);
});
