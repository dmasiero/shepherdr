// fork: Snooze (SHEP-78): the wake rule, the shared entries and Other time…'s words (herdr-task's when.py).
import { expect, test } from "bun:test";
import { startsAt } from "./tasks.js";
import { judge, resolve, signature, snoozeIn, unsnooze, snoozedUntil, wokeOf, nextWake, snoozedLabels, whenOf, untilLine, WHY, canSnooze, LAST, lastOf, sameAsLast } from "./snooze.js";
import { SNOOZE_PICKS } from "./menus.js";

const T0 = new Date(2026, 10, 20, 10, 0).getTime(); // Fri 20 Nov 2026 10:00, this machine's time
const H = 3600_000;
const KEY = ":/srv/shop#7";
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

// fork: Same as last (SHEP-80)
test("Same as last: the last snooze's moment while ahead, never one the picks come to", () => {
  expect(LAST).toBe("tasks.lastSnooze");
  expect(lastOf(T0 + 5 * H, T0)).toEqual({ until: T0 + 5 * H, at: T0 });
  const sat = new Date(2026, 10, 21, 18, 30).getTime();
  expect(sameAsLast(lastOf(sat, T0), SNOOZE_PICKS, T0)).toBe(sat);
  // past or now: none; nothing kept, or nonsense: none
  expect(sameAsLast(lastOf(sat), SNOOZE_PICKS, sat)).toBeNull();
  expect(sameAsLast(lastOf(sat), SNOOZE_PICKS, sat + 1)).toBeNull();
  for (const v of [null, undefined, {}, { until: "soon" }, { until: NaN }, [], 5]) expect(sameAsLast(v, SNOOZE_PICKS, T0)).toBeNull();
  // the same minute as a pick shown below it: Tomorrow 9:00, Monday 9:00, In 3 hours (to the minute)
  expect(sameAsLast(lastOf(new Date(2026, 10, 21, 9, 0).getTime()), SNOOZE_PICKS, T0)).toBeNull();
  expect(sameAsLast(lastOf(new Date(2026, 10, 23, 9, 0, 20).getTime()), SNOOZE_PICKS, T0)).toBeNull();
  expect(sameAsLast(lastOf(T0 + 3 * H + 30_000), SNOOZE_PICKS, T0)).toBeNull();
  // a minute off any of them: offered
  expect(sameAsLast(lastOf(new Date(2026, 10, 21, 9, 1).getTime()), SNOOZE_PICKS, T0)).toBe(new Date(2026, 10, 21, 9, 1).getTime());
  // the next day the same 9:00 is no pick any more (Tomorrow is the 22nd then): offered
  expect(sameAsLast(lastOf(new Date(2026, 10, 21, 9, 0).getTime()), SNOOZE_PICKS, T0 - 24 * H + H)).toBe(new Date(2026, 10, 21, 9, 0).getTime());
  // the words as a Snoozed row says them
  expect(untilLine(startsAt(sat, T0))).toBe("Snoozed until Tomorrow 18:30");
});

// SHEP-79: times typed without the colon, the same table as test/test_herdr_task.py's ColonlessTimes (when.py).
const THU = new Date(2026, 10, 5, 10, 0).getTime(); // a Thursday, 10:00, this machine's time
const COLONLESS = [
  ["1830", "Thu 2026-11-05 18:30"], ["2345", "Thu 2026-11-05 23:45"], ["230", "Fri 2026-11-06 02:30"],
  ["0915", "Fri 2026-11-06 09:15"], ["230pm", "Thu 2026-11-05 14:30"], ["fri 1830", "Fri 2026-11-06 18:30"],
  ["2026-11-06 0900", "Fri 2026-11-06 09:00"], ["tomorrow 0900", "Fri 2026-11-06 09:00"],
  ["at 1830", "Thu 2026-11-05 18:30"], ["1230am", "Fri 2026-11-06 00:30"], ["0000", "Fri 2026-11-06 00:00"],
  ["2:30", "Fri 2026-11-06 02:30"], ["18.30", "Thu 2026-11-05 18:30"], ["9am", "Fri 2026-11-06 09:00"],
];
const COLONLESS_REFUSED = ["2460", "1875", "9", "12345", "1830pm", "0030am", "18", "2026-11-06"];
const words = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("Other time… takes a time without the colon, as when.py", () => {
  for (const [typed, want] of COLONLESS) expect([typed, words(whenOf({ at: typed }, THU).at)]).toEqual([typed, want]);
  for (const typed of COLONLESS_REFUSED) expect([typed, typeof whenOf({ at: typed }, THU).error]).toEqual([typed, "string"]);
  for (const [typed, mins] of [["90m", 90], ["6h", 360], ["in 2 days", 2880], ["1h 30m", 90]]) expect(whenOf({ at: typed }, THU)).toEqual({ at: THU + mins * 60_000 });
  expect(whenOf({ at: "9" }, THU).error).toContain('"18:00" or "1800"');
});
