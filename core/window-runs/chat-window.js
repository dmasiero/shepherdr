// fork: SHEP-17. The window chat's rows, built and drawn by the real mod (mods/chat/main.js) with "herdr" and GPUI's
// builders stood in for, from a Claude log read by core/chat-log.js's own reader. Run by core/chat-window.test.js in
// a bun of its own (a module mock here would clash with the other window tests' in one run).
import { expect, test, mock, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const noop = () => undefined;
const store = {};
let zoom = 1.7;
const el = () => {
  const me = { kids: [], calls: [] };
  const p = new Proxy(function () {}, {
    get(_t, k) {
      if (k === "me") return me;
      if (k === "then") return undefined;
      return (...a) => {
        if (k === "when") { if (a[0]) a[1](p); return p; }
        if (k === "child") { me.kids.push(a[0]); return p; }
        if (k === "children") { me.kids.push(...(a[0] ?? [])); return p; }
        me.calls.push([k, ...a]);
        return p;
      };
    },
  });
  return p;
};
const state = () => new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => (k === "value" ? "" : undefined)) });
const NAMES = "agents appHome closeOverlay exec focused hc home knownAgents layout machines nextCommand notify openOverlay panes playSound props readTextFile run setShared settings shared spaces terminals theme watchFolder window writeTextFile".split(" ");
const herdr = {
  ...Object.fromEntries(NAMES.map((n) => [n, noop])),
  shared: (k) => store[k], setShared: (k, v) => { store[k] = v; }, machines: () => [], spaces: () => [], panes: () => [],
  agents: () => [], terminals: () => [], knownAgents: () => [], props: () => null, layout: () => null, focused: () => null,
  theme: () => new Proxy({}, { get: () => "#000" }), settings: () => ({ zoom }), home: () => "/h", appHome: () => "/a",
  exec: async () => ({ stdout: "", stderr: "", code: 0 }), hc: async () => ({ stdout: "", stderr: "", code: 0 }),
  nextCommand: () => new Promise(noop), watchFolder: () => new Promise(noop), readTextFile: async () => "", writeTextFile: async () => {},
};
mock.module("herdr", () => herdr);
mock.module("gpui-kit", () => ({ View: class {}, div: el, svg: el, image: el }));
// A component class: any of its builders (TextView.markdown, Scrollbar.vertical, ...) makes an element.
const comp = new Proxy(el, { get: (_t, k) => (k === "then" ? undefined : el) });
mock.module("gpui-base", () => ({ v_flex: el, h_flex: el, Input: comp, Textarea: comp, TextView: comp, Scrollbar: comp,
  InputState: { new: state }, TextareaState: { new: state }, VirtualListScrollHandle: { new: state },
  v_virtual_list: (...a) => { const e = el(); e.me.list = a; return e; } }));

let Chat, LOG, records;
beforeAll(async () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: noop };
  ({ default: Chat } = await import("../../mods/chat/main.js"));
  ({ LOG, records } = await import("../../mods/chat/core/chat-log.js"));
});

const cx = { notify: noop, spawn: noop, timer: { every: noop, after: noop }, focus_handle: () => ({ focus: noop }), bind_keys: noop, sleep: () => new Promise(noop), stop_propagation: noop };
const dir = mkdtempSync(join(tmpdir(), "chat-window-"));
const at = (s) => new Date(Date.UTC(2026, 10, 7, 13, 0, s)).toISOString();
// Lines as Claude Code writes them: the reader matches on their keys' order (LOG).
let n = 0;
const user = (content, s) => ({ isSidechain: false, type: "user", message: { role: "user", content }, uuid: `u${++n}`, timestamp: at(s) });
const assistant = (content, s) => ({ isSidechain: false, message: { role: "assistant", content }, type: "assistant", uuid: `a${++n}`, timestamp: at(s) });
const said = (text, s) => assistant([{ type: "text", text }], s);
const ran = (id, command, s) => assistant([{ type: "tool_use", id, name: "Bash", input: { command, description: "Run it" } }], s);
const out = (id, text, s) => user([{ type: "tool_result", tool_use_id: id, content: text }], s);
// A Claude log as a file, read as the chat reads it (LOG's "page"), into the chat's records.
function logOf(name, lines) {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const { head, records: recs } = records(execFileSync("sh", ["-c", LOG, "log", "page", path, "999999999999999", "200"], { encoding: "utf8" }));
  return { path, head, recs };
}
// A task's chat in the Tasks panel (a thread), as the Tasks list opens it, its log read in.
function thread(log, { ended = false, width = 600 } = {}) {
  const v = new Chat();
  v.init({ inner: true, thread: true, terminal: "t6j", task: "INF-6", title: "A task", ...(ended ? { log: { path: log.path, kind: "claude" }, key: "k" } : {}) }, cx);
  Object.assign(v, { path: log.path, kind: "claude", start: Number(log.head[1]), end: Number(log.head[2]), records: log.recs, phase: "ready", width });
  if (ended) v.ended = true;
  v.rebuild();
  return v;
}
const all = (e, o = []) => { if (e?.me) { o.push(e.me); for (const k of e.me.kids) all(k, o); } return o; };
// Draws the chat, and every row the list would draw.
function draw(v) {
  const tree = v.render(cx);
  const list = all(tree).find((x) => x.list);
  if (list) list.list[4]({ start: 0, end: list.list[1] });
  return tree;
}

const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long last reply, long enough to fold under Show more.`).join("\n\n");

// INF-6: a task done and merged, its agent ended before its chat was opened. The person reacted, the agent reacted and
// replied to a reply, and Herdr's news reached it.
test("a finished task's chat builds and draws its rows (INF-6)", () => {
  const log = logOf("inf6", [
    user("Remove the stale fax endpoint from the live config. Mentions INF-4 and #5.", 1),
    said("I'll start by setting my status, then back up the live config.", 2),
    ran("toolu_1", "ssh root@pbx 'cp sip.conf sip.conf.bak'", 3), out("toolu_1", "ok", 4),
    said("Backed up. Removing the peer now.", 5),
    user('<hc from="person" reaction="👍" to="Backed up. Removing the peer now."/>', 6),
    said("<hc no-reply/>", 7),
    user('<hc reply-to="Backed up. Removing the peer now."/>\nAlso check the dialplan.', 8),
    said('<hc react="👀" to="Also check the dialplan."/>\nChecked: the dialplan is clean.', 9),
    user('<herdr-news task="INF-6" event="done">INF-6 is done: Remove the stale fax endpoint</herdr-news>', 10),
    said("Done, and merged.", 11),
  ]);
  const v = thread(log, { ended: true });
  // As the Tasks list's click leaves it: no live terminal read, so no tasks loaded.
  expect(v.t ?? null).toBe(null);
  expect(v.tasks).toBeUndefined();
  let rows;
  expect(() => { rows = v.rows(); }).not.toThrow();
  expect(rows.filter((r) => r.kind === "agent").length).toBeGreaterThanOrEqual(4);
  expect(rows.find((r) => r.kind === "user" && /stale fax endpoint/.test(r.text))).toBeTruthy();
  expect(() => draw(v)).not.toThrow();
  // Its tasks loaded later: mentions are worked out again from them.
  v.tasks = [{ id: 4, ref: "INF-4", title: "Another task" }];
  expect(v.rows().some((r) => r.kind === "chips")).toBe(true);
});

// MASI-1: the newest message is long and folds; Doug's window draws at zoom 1.7, the task's chat about 1130 px wide.
for (const [z, width] of [[1.7, 1130], [1.7, 2000], [1, 700]]) {
  test(`Show more on the newest message opens at zoom ${z}, ${width} px wide (MASI-1)`, () => {
    zoom = z;
    const log = logOf(`masi1-${z}-${width}`, [user("Write it up.", 1), said("Short first reply.", 2), said(long, 3)]);
    const v = thread(log, { width });
    // A live agent's chat: its tasks loaded (loadTasks()).
    v.tasks = [];
    let rows = v.rows();
    const fold = rows.find((r) => r.kind === "fold");
    expect(fold).toBeTruthy();
    expect(rows.filter((r) => r.kind === "agent").at(-1).clip).toBeGreaterThan(0);
    draw(v);
    // The column as drawn: at zoom 1, centred, the words 12 px in (rowBare()'s fold); a press 20 px into
    // "Show more", reported at the zoom as Herdr reports it, against the chat's root.
    const w1 = width / z, left1 = (w1 - Math.min(w1, 760 + 36)) / 2 + 18;
    v.press = { x: (left1 + 12 + 20) * z, y: 10, at: Date.now() };
    v.clickRow(fold.id, rows, cx, rows.map(() => 30));
    rows = v.rows();
    expect(rows.find((r) => r.kind === "fold").open).toBe(true);
    expect(rows.filter((r) => r.kind === "agent").at(-1).clip).toBeUndefined();
    expect(() => draw(v)).not.toThrow();
    // Beside the words (the bubble's far side) it stays as it is.
    v.press = { x: (left1 + 12 + 400) * z, y: 10, at: Date.now() };
    v.clickRow(fold.id, rows, cx, rows.map(() => 30));
    expect(v.rows().find((r) => r.kind === "fold").open).toBe(true);
    zoom = 1.7;
  });
}

// ---- SHEP-18: every press in the chat at Herdr's zoom ----------------------------------------------------------------
// Herdr reports a press (local_position), the pane's size and each measured control's width in pixels at its zoom,
// while the column is laid out at zoom 1. Each test sizes the pane and measures the controls through the mod's own
// handlers, as Herdr would report them, then presses where the control is drawn (worked out at zoom 1, here, from the
// layout: the column centred, at most 760 wide plus 18 each side; a card's border and padding 13 in), times the zoom.

// The handler an element registered, by its id.
function handler(tree, id, name) {
  const node = all(tree).find((m) => m.calls.some((c) => c[0] === "id" && c[1] === id));
  return node?.calls.find((c) => c[0] === name)?.[1];
}
// The pane at `width` px as Herdr reports it (the root's on_size_change).
function sizeTo(v, width) {
  handler(draw(v), "chat", "on_size_change")({ width, height: 900 }, cx);
}
// Each card control measured as drawn (strips.measure()'s on_size_change), `w1(ctl)` px wide at zoom 1, reported at
// the zoom; the Accept the same.
const w1 = (label) => String(label).length * 7 + 20;
function measure(v, ctls, z) {
  const tree = draw(v);
  for (const c of ctls) handler(tree, `mwb-${c.id}`, "on_size_change")?.({ width: w1(c.label) * z, height: 24 * z }, cx);
  handler(tree, "mw-accept", "on_size_change")?.({ width: 66 * z, height: 20 * z }, cx);
}
// The column's edges at zoom 1 (rowBare()'s col(): centred, max_w 760 + 36, px 18).
function column(width, z) {
  const p = width / z, outer = Math.min(p, 760 + 36), left = (p - outer) / 2 + 18;
  return { left, right: left + outer - 36 };
}
const press = (v, x1, z) => { v.press = { x: x1 * z, y: 10, at: Date.now() }; };
const cardRows = (v) => v.rows().filter((r) => r.kind === "cardstrip");

// MASI-1's card: three questions, one Submit on the last step.
const ASK = { tool_name: "AskUserQuestion", tool_input: { questions: [
  { header: "Success =", question: "What counts as success?", multiSelect: false, options: [{ label: "Inbox zero (Recommended)", description: "Every mail sorted" }, { label: "A daily digest", description: "" }] },
  { header: "Gmail tool", question: "Which Gmail tool?", multiSelect: false, options: [{ label: "The Gmail MCP", description: "" }, { label: "gog", description: "" }] },
  { header: "November", question: "Start in November?", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] },
] } };

for (const [z, width] of [[1.7, 1130], [1.7, 2000], [1, 1130], [1, 700]]) {
  test(`a three-question card: pills, Next, options and Submit at zoom ${z}, ${width} px wide (MASI-1, SHEP-18)`, async () => {
    zoom = z;
    const { words } = await import("../../mods/chat/core/asks.js");
    const v = thread(logOf(`ask-${z}-${width}`, [user("Plan it.", 1), said("A few questions first.", 2)]), { width: 600 });
    v.tasks = [];
    const ask = { id: "t6j.1730984400.4242", req: ASK, words: words(ASK) };
    v.asks = [ask];
    const replies = [];
    v.reply = (a, text) => { replies.push({ a, text }); v.asks = v.asks.filter((x) => x !== a); };
    sizeTo(v, width);
    const { left, right } = column(width, z);
    const inner = { left: left + 13, right: right - 13 };
    const strip = (key) => cardRows(v).find((r) => r.s.key === key);
    const click = (r) => { const rows = v.rows(); v.clickRow(r.id, rows, cx, rows.map(() => 30)); };
    const step = () => v.cards.state(ask).step;
    const measureAll = () => measure(v, cardRows(v).flatMap((r) => [...(r.s.ctls ?? []), ...(r.s.links ?? [])]), z);
    measureAll();

    // A step pill (align start, 4 apart): "November", the third.
    const pills = strip("steps").s.ctls;
    const pillAt = (i) => inner.left + pills.slice(0, i).reduce((a, c) => a + w1(c.label) + 4, 0) + w1(pills[i].label) / 2;
    press(v, pillAt(2), z); click(strip("steps"));
    expect(step()).toBe(2);
    press(v, pillAt(0), z); click(strip("steps"));
    expect(step()).toBe(0);
    // Next (align end) on the first step.
    measureAll();
    const next = strip("next0");
    press(v, inner.right - w1(next.s.ctls[0].label) / 2, z); click(next);
    expect(step()).toBe(1);
    press(v, pillAt(0), z); click(strip("steps"));
    expect(step()).toBe(0);
    // An option, anywhere along its row: picked, and the card moves on.
    for (const [i, k] of [[0, 0], [1, 1], [2, 0]]) {
      press(v, inner.left + 40, z); click(strip(`q${i}-${k}`));
      expect([...v.cards.state(ask).picks[i]]).toEqual([k]);
    }
    expect(step()).toBe(3);
    measureAll();
    const submit = strip("submit");
    expect(submit.s.ctls[0].disabled).toBe(false);
    // Beside Submit (the card's left side): nothing.
    press(v, inner.left + 20, z); click(submit);
    expect(replies.length).toBe(0);
    // On Submit (right-aligned): the answers go.
    press(v, inner.right - w1("Submit") / 2, z); click(submit);
    expect(replies.length).toBe(1);
    const sent = JSON.parse(replies[0].text).hookSpecificOutput.decision.updatedInput.answers;
    expect(sent).toEqual({ "What counts as success?": "Inbox zero", "Which Gmail tool?": "gog", "Start in November?": "Yes" });
    zoom = 1.7;
  });
}

for (const [z, width] of [[1.7, 1130], [1, 700]]) {
  test(`an action band, a Ready line's Accept and task chips at zoom ${z}, ${width} px wide (SHEP-18)`, () => {
    zoom = z;
    const v = thread(logOf(`band-${z}-${width}`, [user("Write it up.", 1), said("Here it is.", 2)]), { width: 600 });
    v.tasks = [];
    sizeTo(v, width);
    measure(v, [], z);
    const { left, right } = column(width, z);
    const rows = v.rows();
    const clickAt = (r, x1) => { press(v, x1, z); v.clickRow(r.id, [...rows, r], cx, rows.map(() => 30)); };

    // Bands: drawn inside the column, and a press on each button runs it.
    const acted = [];
    v.act = (_bar, what) => acted.push(what);
    const bands = rows.filter((r) => r.kind === "band");
    expect(bands.length).toBeGreaterThanOrEqual(2);
    for (const b of bands) {
      const parts = v.barLayout(b.bar).parts.filter((p) => p.what !== "time" && !p.what.startsWith("pill:"));
      expect(parts.length).toBeGreaterThan(0);
      for (const p of parts) {
        expect(p.x).toBeGreaterThanOrEqual(left - 0.5);
        expect(p.x + p.w).toBeLessThanOrEqual(right + 0.5);
        acted.length = 0;
        clickAt(b, p.x + p.w / 2);
        expect(acted).toEqual([p.what]);
      }
    }
    // Under a user's message the band is at the column's right; an agent's at its left.
    const user1 = bands.find((b) => b.bar.side === "user"), agent1 = bands.find((b) => b.bar.side !== "user");
    const lay = (b) => v.barLayout(b.bar);
    expect(lay(user1).x + lay(user1).w).toBeCloseTo(right, 3);
    expect(lay(agent1).x).toBeCloseTo(left, 3);

    // A Ready line's Accept: at the line's right end (col(…, 12, 0), then px 6), 66 px wide at zoom 1.
    const accepted = [], opened = [];
    v.acceptTask = (row) => accepted.push(row.ref);
    v.openTask = (id) => opened.push(id);
    const p1 = width / z, end = (p1 + Math.min(p1, 760 + 24) - 24) / 2 - 6;
    const news = { kind: "tasknews", id: "tn:1", ref: "MASI-1", taskId: 1, accept: true };
    clickAt(news, end - 30);
    expect(accepted).toEqual(["MASI-1"]);
    clickAt(news, end - 200);
    expect(accepted).toEqual(["MASI-1"]);
    expect(opened).toEqual([1]);

    // Task chips: right-aligned at the column's right, 170 wide, 6 apart.
    opened.length = 0;
    const chips = { kind: "chips", id: "ch:1", tasks: [{ id: 7 }, { id: 8 }] };
    clickAt(chips, right - 85);
    clickAt(chips, right - 170 - 6 - 85);
    expect(opened).toEqual([8, 7]);
    zoom = 1.7;
  });
}
