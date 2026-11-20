// fork: Snooze (SHEP-78), Gmail's: a started task not done leaves the lists and every count until a time the person
// picks, or until it needs them again. It is the person's view, not the task's (as a pin): the service's shared
// document keeps it beside the pins, "tasks.snoozed" = { <pin key>: entry } (core/tasks.js taskKey:
// "<machine, empty here>:<folder>#<id>"), carried to the window by lib/bridge.js. herdr-task, the Assistant and the
// agents never see it.
//
// An entry is either snoozed, { until, at, seen, task }, or back, { woke, at }:
//   until  when it comes back by itself (ms); at: when it was snoozed (or woke)
//   seen   its signature when it was snoozed (signature()): its status, its open cards, its last Ready time
//   task   its agents' label ("<slug>#<id>", herdr.task): the window finds its terminals by it
//   woke   why it came back ("Asked a question", "Blocked", "Ready", "Time's up"), until the person opens it
//
// Waking is worked out, not listened for (resolve()): a task stays snoozed while now < until and nothing that asks for
// the person changed since `seen`. Every service gets the same answer from the same task; the first that sees a wake
// writes the entry back as { woke }. A task done, archived or gone drops its entry.
// The shared core: the service, the web app and the window's mods load this one file (bin/sync-shared copies it); it
// imports nothing, so inbox.js's mods need no other core file for it.

export const SNOOZED = "tasks.snoozed";

// The statuses a task can be snoozed in: started and not done (the web's words and the window's). To do, Queued and
// Scheduled have Start later instead; Done and Archived nothing.
const STATUS = { need: "need", needs: "need", work: "work", working: "work", ready: "ready", merging: "merging" };
export const canSnooze = (status) => Boolean(status && STATUS[status]);

export const WHY = { asked: "Asked a question", blocked: "Blocked", ready: "Ready", time: "Time's up" };

// A task's signature now: { status, cards (its open question and secret cards' ids, sorted), ready (its last Ready time) }.
/** @param {{ status?: string | null, cards?: string[], ready?: number | null }} [s] */
export function signature({ status = null, cards = [], ready = null } = {}) {
  return { status: STATUS[status] ?? status ?? null, cards: [...new Set((cards ?? []).map(String))].sort(), ready: typeof ready === "number" ? ready : null };
}

// What an entry says now for a task with that signature (null: a task not here, untouched):
//   { snoozed: until }                 still snoozed
//   { snoozed: until, seen }           still snoozed, its status moved on without asking for the person (to Working,
//                                      Merging): `seen` takes the new status, so a later Needs you or Ready wakes it
//   { woke: why }                      back now
//   { drop: true }                     done, archived or gone: the entry goes
// A Needs you task wakes on a new card only, never the one it showed when snoozed; a card a service can't see (another
// machine's ask) is no change, so two services never disagree by what they see.
export function judge(entry, now, at = Date.now()) {
  if (!entry || typeof entry !== "object") return null;
  if (!now || !canSnooze(now.status)) return { drop: true };
  if (typeof entry.until !== "number") return null;
  const seen = signature(entry.seen ?? {}), sig = signature(now);
  if (sig.cards.some((c) => !seen.cards.includes(c))) return { woke: WHY.asked };
  if (sig.status === "need" && seen.status !== "need") return { woke: WHY.blocked };
  if (sig.status === "ready" && (seen.status !== "ready" || (sig.ready !== null && sig.ready !== seen.ready))) return { woke: WHY.ready };
  if (at >= entry.until) return { woke: WHY.time };
  if (sig.status !== seen.status || sig.ready !== seen.ready) return { snoozed: entry.until, seen: { ...seen, status: sig.status, ready: sig.ready } };
  return { snoozed: entry.until };
}

// Every entry against the tasks now: tasks = Map(pin key -> signature, or null for one done or archived). A key the
// map doesn't have (its machine not read yet, offline) is left as it is. -> { map: the entries now, changed, woke: [{
// key, why }] }, the map the same object when nothing changed.
export function resolve(map, tasks, at = Date.now()) {
  const was = entries(map);
  const out = {}, woke = [];
  let changed = false;
  for (const [key, e] of Object.entries(was)) {
    if (!tasks.has(key)) { out[key] = e; continue; }
    const now = tasks.get(key);
    if (e.woke) {
      // back: kept until the person opens it, gone once it's done
      if (now && canSnooze(now.status)) out[key] = e; else changed = true;
      continue;
    }
    const j = judge(e, now, at);
    if (!j || (j.snoozed && !j.seen)) { out[key] = e; continue; }
    changed = true;
    if (j.drop) continue;
    if (j.seen) { out[key] = { ...e, seen: j.seen }; continue; }
    out[key] = { woke: j.woke, at: j.woke === WHY.time ? e.until : at };
    woke.push({ key, why: j.woke });
  }
  return { map: changed ? out : map, changed, woke };
}

const entries = (map) => (map && typeof map === "object" && !Array.isArray(map) ? map : {});

// The entries with a task snoozed until a time, now or a wake undone; with one back, or without it.
/** @param {any} map @param {string} key @param {{ until: number, seen: any, task?: string | null, at?: number }} o */
export function snoozeIn(map, key, { until, seen, task = null, at = Date.now() }) {
  return { ...entries(map), [key]: { until, at, seen: signature(seen), ...(task ? { task } : {}) } };
}
export function unsnooze(map, key) {
  const { [key]: _, ...rest } = entries(map);
  return rest;
}

// fork: Same as last (SHEP-80): the last snooze's moment, whatever picked it (a pick, Other time…, Same as last), so the
// next task snoozes to the same: "tasks.lastSnooze" = { until, at } beside the snoozes, carried the same way (the
// service's shared document, lib/bridge.js), so the phone, the web and the window offer the same one.
export const LAST = "tasks.lastSnooze";
export const lastOf = (until, at = Date.now()) => ({ until, at });
// The moment Same as last offers (ms), null for none: the last one's while it's still ahead, not when one of the picks
// below it (core/menus.js SNOOZE_PICKS: their { in } or { at } words) comes to the same minute now.
export function sameAsLast(last, picks = [], at = Date.now()) {
  const u = last && typeof last === "object" ? last.until : null;
  if (typeof u !== "number" || !Number.isFinite(u) || u <= at) return null;
  const minute = (ms) => Math.floor(ms / 60000);
  for (const p of picks ?? []) {
    const w = whenOf(p.in !== undefined ? { in: p.in } : { at: p.at }, at);
    if (w.at !== undefined && minute(w.at) === minute(u)) return null;
  }
  return u;
}

// A task's snooze as the lists show it: until when (ms) while snoozed and its time not up, else null. Between a wake
// and the service writing it (a few seconds), the time alone decides.
export function snoozedUntil(map, key, at = Date.now()) {
  const e = entries(map)[key];
  return e && typeof e.until === "number" && at < e.until ? e.until : null;
}
// Why it came back, until the person opens it; null when it isn't back.
export const wokeOf = (map, key) => (typeof entries(map)[key]?.woke === "string" ? entries(map)[key].woke : null);
// The soonest time a snoozed task comes back by itself (ms), Infinity: none (the service builds again then).
export const nextWake = (map, at = Date.now()) => Math.min(Infinity, ...Object.values(entries(map)).map((e) => e?.until).filter((u) => typeof u === "number" && u > at));
// Every snoozed task's agents' label ("<slug>#<id>"), keyed by machine (empty here): the window's counts leave them out.
export function snoozedLabels(map, at = Date.now()) {
  const out = new Set();
  for (const [key, e] of Object.entries(entries(map))) if (e?.task && typeof e.until === "number" && at < e.until) out.add(`${key.slice(0, key.indexOf(":"))}|${e.task}`);
  return out;
}

// A snoozed row's line: "Snoozed until Mon 9:00", given core/tasks.js startsAt's words (as Scheduled's "Starts Mon 9:00").
export const untilLine = (words) => `Snoozed until ${words}`;
export const BACK = "Back from snooze";

// ---- Other time… (typed): herdr-task's when.py, the same words the same way --------------------------------------
// "2026-11-06 09:00", "tomorrow 9:00", "fri 8:15", "today 18:00", "18:00", or a span from now ("6h", "in 2 days").
// -> { at } (ms) or { error } in herdr-task's words. This machine's time zone (the service's: the person's).
export const AT_HOW = 'Write a time like "2026-11-06 09:00", "tomorrow 9:00", "fri 8:15", "today 18:00" or "18:00" (this machine\'s time zone).';
export const IN_HOW = 'Write a span like "6h", "90m", "2 days", "6 hours" or "1h 30m".';
const UNITS = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, w: 10080, wk: 10080, week: 10080, weeks: 10080 };
const NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
class Fail extends Error {}

function parseClock(text, how = AT_HOW) {
  const t = text.trim().toLowerCase();
  if (t === "noon" || t === "midday") return [12, 0];
  if (t === "midnight") return [0, 0];
  const m = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  const bad = () => new Fail(`Unknown time '${text.trim()}'. ${how}`);
  if (!m || (m[2] === undefined && m[3] === undefined)) throw bad();
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0), ap = (m[3] ?? "").replace(/\./g, "");
  if (ap) {
    if (h < 1 || h > 12) throw bad();
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  }
  if (h > 23 || mi > 59) throw bad();
  return [h, mi];
}

// days ahead of today for a day word, null: not a day (when.py day_of; Monday 0 there, as Python's weekday())
function dayOf(word, now = new Date()) {
  const w = String(word ?? "").trim().toLowerCase().replace(/^(next|this) /, "");
  if (w === "today" || w === "tonight") return 0;
  if (["tomorrow", "tmrw", "tmr"].includes(w)) return 1;
  const hit = NAMES.findIndex((n) => (w.length >= 2 && n.startsWith(w)) || [n.slice(0, 3), n.slice(0, 3) + "s", n.slice(0, 4)].includes(w));
  if (hit < 0) return null;
  const weekday = (now.getDay() + 6) % 7;
  return (((hit - weekday) % 7) + 7) % 7;
}

function parseAt(text, nowMs) {
  let t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  t = t.replace(/(^| )at (?=\d|noon|midnight)/g, "$1").trim().replace(/,/g, " ").trim().replace(/\s+/g, " ");
  if (!t) throw new Fail(`Say when. ${AT_HOW}`);
  const now = new Date(nowMs);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](.+))?$/.exec(t);
  if (m) {
    if (!m[4]) throw new Fail(`Give a time of day too, like "${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")} 09:00".`);
    const [h, mi] = parseClock(m[4]);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), h, mi);
    if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) throw new Fail(`No such date: ${String(text).trim()}`);
    return d.getTime();
  }
  m = /^(?:((?:next |this )?[a-z]+) )?(.+)$/.exec(t);
  const dayWord = m[1], clock = m[2];
  if (dayWord === undefined && dayOf(t, now) !== null) throw new Fail(`Give a time of day too, like "${t} 9:00". ${AT_HOW}`);
  const ahead = dayWord ? dayOf(dayWord, now) : null;
  if (dayWord && ahead === null) throw new Fail(`Unknown day '${dayWord}'. ${AT_HOW}`);
  const [h, mi] = parseClock(clock);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
  const plus = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
  if (dayWord === undefined) return (base > now ? base : plus(base, 1)).getTime();
  let d = plus(base, ahead);
  if ((dayWord === "today" || dayWord === "tonight") && d <= now) throw new Fail(`${clock} today has passed. ${AT_HOW}`);
  if (d <= now) d = plus(d, 7);
  return d.getTime();
}

function parseIn(text) {
  const t = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^in /, "").replace(/ and /g, " ").replace(/,/g, " ").trim();
  if (!t) throw new Fail(`Say how long from now. ${IN_HOW}`);
  let total = 0, pos = 0;
  for (const m of t.matchAll(/\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*/g)) {
    if (m.index !== pos || !(m[2] in UNITS)) throw new Fail(`Unknown span '${String(text).trim()}'. ${IN_HOW}`);
    total += Number(m[1]) * UNITS[m[2]];
    pos = m.index + m[0].length;
  }
  if (pos !== t.length || total <= 0) throw new Fail(`Unknown span '${String(text).trim()}'. ${IN_HOW}`);
  return Math.round(total * 60000);
}

// when.py when_from: { at: words } or { in: span } -> { at: ms } or { error }. A span typed where a time goes is from now.
/** @param {{ at?: string, in?: string }} [w] @returns {{ at: number, error?: undefined } | { error: string, at?: undefined }} */
export function whenOf({ at = undefined, in: within = undefined } = {}, nowMs = Date.now()) {
  try {
    if (at !== undefined && within !== undefined) throw new Fail("Give a time or a span, not both.");
    if (within !== undefined) return { at: nowMs + parseIn(within) };
    let ms;
    try { ms = parseAt(at, nowMs); } catch (e) {
      if (!(e instanceof Fail)) throw e;
      try { return { at: nowMs + parseIn(at) }; } catch { throw new Fail(`${e.message} Or a span from now, like "6h" or "in 2 days".`); }
    }
    if (ms <= nowMs) throw new Fail(`${String(at).trim()} has passed. ${AT_HOW}`);
    return { at: ms };
  } catch (e) {
    if (e instanceof Fail) return { error: e.message };
    throw e;
  }
}
