// fork: Snooze (SHEP-78): the wake rule, the shared entries and Other time…'s words (herdr-task's when.py).
import { expect, test } from "bun:test";
import { startsAt } from "./tasks.js";
import { judge, resolve, signature, snoozeIn, unsnooze, snoozedUntil, wokeOf, nextWake, snoozedLabels, whenOf, untilLine, WHY, canSnooze } from "./snooze.js";

const T0 = new Date(2026, 10, 20, 10, 0).getTime(); // Fri 20 Nov 2026 10:00, this machine's time
const H = 3600_000;
const KEY = ":/home/d/dev/shop#7";
const snoozed = (seen, until = T0 + 3 * H) => snoozeIn({}, KEY, { until, seen, task: "shop#7", at: T0 });

test("which statuses snooze", () => {
  for (const s of ["need", "needs", "work", "working", "ready", "merging"]) expect(canSnooze(s)).toBe(true);
  for (const s of ["todo", "queued", "scheduled", "done", null]) expect(canSnooze(s)).toBe(false);
});

test("a snoozed task stays snoozed while nothing asks for the person, then its time is up", () => {
  const m = snoozed({ status: "working" });
  expect(judge(m[KEY], { status: "work" }, T0 + H)).toEqual({ snoozed: T0 + 3 * H });
  expect(snoozedUntil(m, KEY, T0 + H)).toBe(T0 + 3 * H);
  expect(judge(m[KEY], { status: "work" }, T0 + 3 * H)).toEqual({ woke: WHY.time });
  // the lists go by the time alone until a service writes the wake
  expect(snoozedUntil(m, KEY, T0 + 3 * H)).toBe(null);
});

test("each change of its signature that asks for the person wakes it, with why", () => {
  const work = snoozed({ status: "working" })[KEY];
  expect(judge(work, { status: "need", cards: ["q1"] }, T0 + H)).toEqual({ woke: WHY.asked });
  expect(judge(work, { status: "need" }, T0 + H)).toEqual({ woke: WHY.blocked });
  expect(judge(work, { status: "ready", ready: T0 + H }, T0 + H)).toEqual({ woke: WHY.ready });
  // Ready again: a new Ready time (rework finished)
  const ready = snoozed({ status: "ready", ready: T0 - H })[KEY];
  expect(judge(ready, { status: "ready", ready: T0 - H }, T0 + H)).toEqual({ snoozed: T0 + 3 * H });
  expect(judge(ready, { status: "ready", ready: T0 + H }, T0 + H)).toEqual({ woke: WHY.ready });
  // done, archived or gone: the entry goes
  expect(judge(ready, { status: "done" }, T0 + H)).toEqual({ drop: true });
  expect(judge(ready, null, T0 + H)).toEqual({ drop: true });
});

test("a Needs you task wakes on a new question only, never the one it showed", () => {
  const need = snoozed({ status: "needs", cards: ["q1"] })[KEY];
  expect(judge(need, { status: "need", cards: ["q1"] }, T0 + H)).toEqual({ snoozed: T0 + 3 * H });
  expect(judge(need, { status: "need", cards: ["q1", "q2"] }, T0 + H)).toEqual({ woke: WHY.asked });
  // answered elsewhere, back at work: still snoozed, its seen status moves on, so asking again wakes it
  const moved = judge(need, { status: "work" }, T0 + H);
  expect(moved).toEqual({ snoozed: T0 + 3 * H, seen: { status: "work", cards: ["q1"], ready: null } });
  expect(judge({ ...need, seen: moved.seen }, { status: "need" }, T0 + 2 * H)).toEqual({ woke: WHY.blocked });
});

test("resolve: woke entries are written back, others kept; an unknown task is left alone", () => {
  const m = { ...snoozed({ status: "working" }), ":/x#1": { until: T0 + H, at: T0, seen: signature({ status: "ready" }) }, "vm:/y#2": { until: T0 + H, at: T0, seen: signature({ status: "work" }) } };
  const tasks = new Map([[KEY, signature({ status: "need", cards: ["q9"] })], [":/x#1", signature({ status: "ready" })]]);
  const r = resolve(m, tasks, T0 + 30 * 60_000);
  expect(r.changed).toBe(true);
  expect(r.woke).toEqual([{ key: KEY, why: WHY.asked }]);
  expect(r.map[KEY]).toEqual({ woke: WHY.asked, at: T0 + 30 * 60_000 });
  expect(r.map[":/x#1"]).toBe(m[":/x#1"]);
  expect(r.map["vm:/y#2"]).toBe(m["vm:/y#2"]); // another machine not read: untouched
  expect(wokeOf(r.map, KEY)).toBe(WHY.asked);
  // nothing changed: the same map, so nothing is written
  const same = resolve(r.map, new Map([[":/x#1", signature({ status: "ready" })]]), T0 + 40 * 60_000);
  expect(same.changed).toBe(false);
  expect(same.map).toBe(r.map);
  // a woke one done: gone; time's up: woke at its time
  const later = resolve(r.map, new Map([[KEY, signature({ status: "done" })], [":/x#1", signature({ status: "ready" })]]), T0 + 2 * H);
  expect(later.map[KEY]).toBeUndefined();
  expect(later.map[":/x#1"]).toEqual({ woke: WHY.time, at: T0 + H });
});

test("two services agree: the same task gives the same answer; one that can't see a card doesn't wake it", () => {
  const m = snoozed({ status: "needs", cards: ["q1"] });
  const here = resolve(m, new Map([[KEY, signature({ status: "need", cards: ["q1"] })]]), T0 + H);
  const there = resolve(m, new Map([[KEY, signature({ status: "need", cards: [] })]]), T0 + H); // its ask is this machine's
  expect(here.changed).toBe(false);
  expect(there.changed).toBe(false);
  const a = resolve(m, new Map([[KEY, signature({ status: "ready", ready: T0 + H })]]), T0 + H);
  const b = resolve(m, new Map([[KEY, signature({ status: "ready", ready: T0 + H })]]), T0 + H);
  expect(a.map).toEqual(b.map);
  expect(a.woke).toEqual([{ key: KEY, why: WHY.ready }]);
});

test("the entries: snooze, unsnooze, the next wake and the window's labels", () => {
  const m = snoozeIn(snoozed({ status: "working" }), "vm:/z#3", { until: T0 + H, seen: { status: "ready" }, task: "z#3", at: T0 });
  expect(nextWake(m, T0)).toBe(T0 + H);
  expect(nextWake({}, T0)).toBe(Infinity);
  expect([...snoozedLabels(m, T0)].sort()).toEqual(["vm|z#3", "|shop#7"].sort());
  expect(unsnooze(m, KEY)).toEqual({ "vm:/z#3": m["vm:/z#3"] });
  expect(unsnooze(null, KEY)).toEqual({});
  expect(untilLine(startsAt(T0 + 3 * 86400_000, T0))).toBe("Snoozed until Mon 10:00");
});

test("Other time… reads times as herdr-task does", () => {
  expect(whenOf({ at: "tomorrow 9:00" }, T0)).toEqual({ at: new Date(2026, 10, 21, 9, 0).getTime() });
  expect(whenOf({ at: "mon 9:00" }, T0)).toEqual({ at: new Date(2026, 10, 23, 9, 0).getTime() });
  expect(whenOf({ at: "fri 8:15" }, T0)).toEqual({ at: new Date(2026, 10, 27, 8, 15).getTime() }); // today's passed: next week
  expect(whenOf({ at: "18:00" }, T0)).toEqual({ at: new Date(2026, 10, 20, 18, 0).getTime() });
  expect(whenOf({ at: "9am" }, T0)).toEqual({ at: new Date(2026, 10, 21, 9, 0).getTime() });
  expect(whenOf({ at: "2026-12-01 09:00" }, T0)).toEqual({ at: new Date(2026, 11, 1, 9, 0).getTime() });
  expect(whenOf({ at: "6h" }, T0)).toEqual({ at: T0 + 6 * H });
  expect(whenOf({ at: "in 1h 30m" }, T0)).toEqual({ at: T0 + 1.5 * H });
  expect(whenOf({ in: "3h" }, T0)).toEqual({ at: T0 + 3 * H });
  expect(whenOf({ at: "someday" }, T0).error).toMatch(/^Unknown time 'someday'\. Write a time like/);
  expect(whenOf({ at: "today 9:00" }, T0).error).toMatch(/^9:00 today has passed\./);
  expect(whenOf({ at: "2026-01-01 09:00" }, T0).error).toMatch(/has passed/);
  expect(whenOf({ at: "fri" }, T0).error).toMatch(/^Give a time of day too/);
  expect(whenOf({ at: "" }, T0).error).toMatch(/^Say when\./);
});
