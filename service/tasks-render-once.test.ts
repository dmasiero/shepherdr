// The Tasks panel's render reads the window layout once, not once per row (SHEP-43): each row's click target asked
// whether the layout has the task drill-in, a full walk of the layout per row, and with many rows the render ran past
// Herdr's budget ("This view could not be re-rendered / interrupted").
import { beforeEach, expect, mock, test } from "bun:test";
import { fakeHerdr } from "./fake-herdr";
import { fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";

const calls = { layout: 0, machines: 0 };
const ran: [string, any][] = [];
const shared = new Map<string, unknown>();
const none = async () => ({ code: 1, stdout: "", stderr: "" });
const theme = new Proxy({}, { get: () => "#000000" });
const tree = {
  id: "root", children: [{ id: "tasks", children: [{ id: "tasks-list" }, { id: "tasks-thread", children: [
    { id: "tasks-thread-body", children: [{ id: "tasks-thread-chat" }, { id: "tasks-thread-term" }] },
  ] }] }],
};
const terms = Array.from({ length: 10 }, (_, i) => ({
  address: `t${i}`, state: "live", status: "working", labels: { "herdr.task": `shop#${i}` }, program: { key: "claude" },
}));
mock.module("herdr", () => fakeHerdr({
  run: (cmd: string, args: any) => { ran.push([cmd, args]); },
  layout: () => { calls.layout++; return tree; },
  machines: () => { calls.machines++; return []; },
  exec: none, hc: none, theme: () => theme, appHome: () => "/nonexistent-app", home: () => "/nonexistent-home",
  readTextFile: async () => null, watchFolder: () => {}, nextCommand: () => new Promise(() => {}),
  shared: (k: string) => shared.get(k), setShared: (k: string, v: unknown) => { shared.set(k, v); },
  agents: () => [], panes: () => [], terminals: () => terms, spaces: () => [],
}));
const inert = (): any => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : k === "value" ? () => "" : () => undefined) });
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase({ InputState: { new: inert } }));
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { default: Tasks } = await import("../mods/tasks/main.js");
const cx: any = new Proxy({ timer: { every: () => {}, after: () => {} } }, { get: (t, k) => (t as any)[k] ?? (() => {}) });

// 200 tasks in every section: working (a live agent), queued, to do, ready, done.
const STATES = ["running", "queued", "todo", "ready", "done"];
const tasks = Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Task ${i}`, state: STATES[i % STATES.length], agents: [] }));
const panel = (n = tasks.length) => {
  const p: any = new Tasks();
  p.init({}, cx);
  p.lists = [{ machine: null, folder: "/tmp/shop", slug: "shop", prefix: "SHOP", name: "shop", tasks: tasks.slice(0, n), automations: [] }];
  return p;
};
// What one render read: the layout's and machines()'s calls.
const reads = (n: number) => {
  const p = panel(n);
  calls.layout = 0; calls.machines = 0;
  p.render(cx);
  return { ...calls };
};

beforeEach(() => { calls.layout = 0; calls.machines = 0; ran.length = 0; shared.clear(); });

for (const group of ["status", "you", "space"]) {
  test(`a render with 200 rows reads the layout once, and machines as often as with 10 (grouped by ${group})`, () => {
    shared.set("tasks.group", group);
    const few = reads(10), many = reads(200);
    expect(many.layout).toBe(1);
    expect(many.machines).toBe(few.machines);
  });
}

test("a row's click still drills into its task after the render", () => {
  shared.set("tasks.group", "status");
  const p = panel();
  p.render(cx);
  expect(p.frame).toBeNull();
  const before = calls.layout;
  const go = p.target(p.place(p.lists[0], tasks[2]));
  expect(calls.layout).toBe(before + 1);
  expect(go).toBeTruthy();
  go();
  expect(shared.get("tasks.thread")).toMatchObject({ task: "SHOP-2", title: "Task 2" });
  expect(ran).toContainEqual(["layout.select", { stack: "tasks", child: "tasks-thread" }]);
});
