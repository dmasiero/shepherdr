// SHEP-51: "Muffle other audio during calls" (audio ducking). While a window call is on, other apps' sound (music in a
// browser, a player) is lowered while the voice agent speaks and while the person speaks, and comes back up after, so
// the call is heard over the music and the person's replies reach the call. Linux (PipeWire or PulseAudio) only: each
// OTHER app's playback stream (pactl's sink inputs) is set to a share of its own volume and back exactly.
// Plain logic and words: mods/chat/muffle.ts does pactl, the guard file and the restore after a crash; voice.ts says
// when to muffle (the agent's voice playing, the person speaking: speechGate below). The web call can't: a browser
// can't change other apps' volume. macOS: Apple's voice processing ducks other audio by itself (docs/voice.md).
// Shared core: the source is core/duck.js.

/** The choices (a share of each app's own volume, as its slider shows it), 0 being off, and the default. */
export const MUFFLE_CHOICES = [0, 10, 25, 50];
export const MUFFLE_DEFAULT = 25;
/** The setting's words, the window's and the web's Settings › Window, under Voice and dictation. */
export const MUFFLE = {
  title: "Muffle other audio during calls",
  about: "Music and other apps go quieter while the call's voice or you speak, and come back after. On Linux; Macs do it by themselves.",
  word: (v) => (v ? `${v}%` : "Off"),
};

/** The level picked: 0 (off) or one of the choices, from ~/.config/shepherdr/settings.json (Everywhere's voice.muffle). */
export function muffleLevel(cfg) {
  const v = cfg?.everywhere?.voice?.muffle;
  if (v === 0 || v === false || v === "off") return 0;
  return MUFFLE_CHOICES.includes(v) ? v : MUFFLE_DEFAULT;
}
/** A word from Settings ("Off", "25%") as the value kept. */
export function muffleFromWord(word) {
  const n = /^(\d+)%?$/.exec(String(word ?? "").trim())?.[1];
  if (n && MUFFLE_CHOICES.includes(Number(n))) return Number(n);
  if (/^off$/i.test(String(word ?? "").trim())) return 0;
  return null;
}

// How it moves: down quickly (the voice is heard from its first words), up slower, and held a moment after the last
// sound so short pauses don't pump the music up and down.
export const DOWN_MS = 250;
export const UP_MS = 800;
export const HOLD_MS = 1000;
/** The call's own speaker is marked with this (pw-play's node properties), so it is never muffled. */
export const CALL_APP = "Herdr call";
export const CALL_PROPS = `{ application.name = "${CALL_APP}" herdr.call = true }`;
// A stream changed by someone else by more than this (of 65536, the full volume) is theirs from then on.
const SLACK = 700;

/**
 * The streams pactl lists (`pactl -f json list sink-inputs`), as { id, vols, key, name, skip }: vols each channel's
 * volume (65536 the full one), key the stream-restore id PipeWire remembers its volume by
 * ("sink-input-by-application-name:Helium"), skip for the call's own sound and for virtual streams (a filter's or a
 * loopback's output carries other apps' sound, already muffled at their own streams). Bad input: [].
 */
export function parseStreams(json) {
  let list;
  try { list = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const id = Number(s?.index);
    const vols = Object.values(s?.volume ?? {}).map((c) => Number(c?.value));
    if (!Number.isInteger(id) || !vols.length || vols.some((v) => !Number.isFinite(v))) continue;
    const p = s.properties ?? {};
    const yes = (k) => p[k] === true || p[k] === "true";
    const ours = yes("herdr.call") || p["application.name"] === CALL_APP;
    const virtual = yes("node.virtual") || yes("node.passive") || Boolean(p["node.link-group"]);
    out.push({ id, vols, key: String(p["module-stream-restore.id"] ?? ""), name: String(p["application.name"] ?? p["media.name"] ?? ""),
      skip: ours || virtual });
  }
  return out;
}

const scale = (vols, g) => vols.map((v) => Math.max(0, Math.round(v * g)));
const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= SLACK);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The muffle itself. io:
 *   list()            the streams now (parseStreams), or null when pactl can't be asked
 *   set(id, vols)     a stream's volume per channel
 *   heal(key, vols)   PipeWire remembers a stream's volume by app (key): a stream that ended while muffled would start
 *                     quiet next time, so its app's remembered volume is put back (muffle.ts plays a moment of silence
 *                     as that app at its old volume)
 *   save(guard|null)  the guard: what to put back if this process dies ({ streams, gone }), null when nothing is
 * step(want, level, now) moves one tick toward muffled (want, at level: 0..1 of each stream's own volume) or full, and
 * returns once its pactl calls are done; release() puts everything back now.
 */
export function ducker(io, { down = DOWN_MS, up = UP_MS, listEvery = 500 } = {}) {
  let g = 1;              // the share every muffled stream is at now
  let lo = 1;             // the lowest it went since it was last full (the way back up takes UP_MS from there)
  let at = null;          // the last step's time
  let listedAt = -Infinity;
  /** id -> { orig, set, key }: the streams muffled now */
  const streams = new Map();
  /** key -> { orig, set }: muffled streams that ended meanwhile (their app's volume to heal) */
  const gone = new Map();
  let saved = "";

  async function save() {
    const guard = streams.size || gone.size
      ? { streams: Object.fromEntries([...streams].map(([id, s]) => [id, s])), gone: Object.fromEntries(gone) } : null;
    const s = JSON.stringify(guard);
    if (s === saved) return;
    saved = s;
    await io.save(guard);
  }

  /** Who is there now: new streams join (at their own volume), ended ones go, one someone changed is left to them. */
  async function look() {
    const now = await io.list();
    if (!now) return;
    const seen = new Set();
    for (const s of now) {
      if (s.skip) continue;
      seen.add(s.id);
      const had = streams.get(s.id);
      if (had) {
        // someone set it meanwhile (the person, the app): theirs, never put back over it
        if (!near(s.vols, had.set)) streams.delete(s.id);
        continue;
      }
      // a stream that came while muffled; one of an app whose muffled stream ended starts at what PipeWire kept for
      // it, the muffled volume: its own is the one before
      const prior = gone.get(s.key);
      let orig = s.vols;
      if (s.key && prior && near(s.vols, prior.set) && prior.orig.length === s.vols.length) { orig = prior.orig; gone.delete(s.key); }
      else if (s.key && prior) gone.delete(s.key);
      streams.set(s.id, { orig, set: s.vols, key: s.key });
    }
    for (const [id, s] of streams) {
      if (seen.has(id)) continue;
      streams.delete(id);
      if (s.key && !same(s.set, s.orig)) gone.set(s.key, { orig: s.orig, set: s.set });
    }
  }

  async function apply() {
    for (const [id, s] of streams) {
      const want = g >= 1 ? s.orig : scale(s.orig, g);
      if (same(want, s.set)) continue;
      await io.set(id, want);
      s.set = want;
    }
  }

  /** Everything back: each stream to its own volume, ended ones' apps healed, the guard gone. */
  async function settle() {
    g = 1; lo = 1;
    await apply();
    streams.clear();
    for (const [key, s] of gone) await io.heal(key, s.orig);
    gone.clear();
    await save();
  }

  return {
    get gain() { return g; },
    get muffled() { return streams.size; },
    async step(want, level, now) {
      const dt = at === null ? 0 : Math.max(0, now - at);
      at = now;
      const target = want && level > 0 && level < 1 ? level : 1;
      if (g === 1 && target === 1 && !streams.size && !gone.size) return;
      // the first tick toward muffled lists at once, then twice a second (new streams, ended ones, the person's own)
      if (g === 1 || now - listedAt >= listEvery) { listedAt = now; await look(); }
      if (target < g) { g = Math.max(target, g - ((1 - target) * dt) / down); lo = Math.min(lo, g); }
      else if (target > g) g = Math.min(target, g + ((1 - lo) * dt) / up);
      if (g >= 1 && target === 1) return settle();
      await apply();
      await save();
    },
    release: settle,
  };
}

/**
 * After a call that died muffling (its guard left behind): each stream it muffled that is still there at the volume it
 * set goes back to its own; one changed meanwhile is left; apps whose muffled stream ended are healed. io as ducker's.
 */
export async function recover(guard, io) {
  if (!guard || typeof guard !== "object") return 0;
  const now = (await io.list()) ?? [];
  let n = 0;
  const left = new Map(Object.entries(guard.gone ?? {}));
  for (const [id, s] of Object.entries(guard.streams ?? {})) {
    if (!Array.isArray(s?.orig) || !Array.isArray(s?.set)) continue;
    const here = now.find((x) => x.id === Number(id));
    if (here) {
      if (near(here.vols, s.set) && !same(s.set, s.orig)) { await io.set(here.id, s.orig); n++; }
    } else if (s.key && !same(s.set, s.orig)) left.set(s.key, { orig: s.orig, set: s.set });
  }
  for (const [key, s] of left) {
    if (!Array.isArray(s?.orig)) continue;
    // a new stream of that app, at the muffled volume PipeWire gave it: back to its own too
    const again = now.find((x) => !x.skip && x.key === key && near(x.vols, s.set));
    if (again && again.vols.length === s.orig.length) await io.set(again.id, s.orig);
    else await io.heal(key, s.orig);
    n++;
  }
  await io.save(null);
  return n;
}

/**
 * Is the person speaking? From the mic's loudness (RMS of 16-bit samples) every 100 ms, as the call already reads it.
 * Music from the speakers leaking into the mic, or a room's hum, isn't speech: a level only counts well over the room's
 * own (a floor learned while nothing is muffled and the agent is quiet: frozen otherwise, so the music going down
 * doesn't lower it), twice in a row (200 ms) to start, and goes on while it stays above a lower line (hysteresis).
 * Music that starts loud at once can still pass for speech: doubt() (the call heard no words from it) takes that level
 * as the room's, so it muffles once, never again and again.
 * feed(rms, now, frozen) -> speaking now.
 */
export function speechGate({ min = 650, keep = 450, over = 3, stay = 2, onset = 2 } = {}) {
  let floor = 200;
  let run = 0;
  let speaking = false;
  let peak = 0;
  return {
    get floor() { return floor; },
    feed(rms, now, frozen = false) {
      const r = Number.isFinite(rms) ? rms : 0;
      const on = Math.max(min, floor * over), off = Math.max(keep, floor * stay);
      if (speaking) {
        if (r < off) { speaking = false; run = 0; }
      } else {
        run = r > on ? run + 1 : 0;
        if (run >= onset) { speaking = true; peak = 0; }
      }
      if (speaking) peak = Math.max(peak, r);
      // the room's floor: falls quickly to a quieter level, rises over a couple of seconds toward a louder one
      if (!frozen && !speaking) floor = r < floor ? floor * 0.7 + r * 0.3 : floor * 0.95 + r * 0.05;
      return speaking;
    },
    /** What last counted as speech wasn't (no words came of it): the room is that loud now. */
    doubt() {
      if (peak) floor = Math.max(floor, (peak * 1.25) / over);
      peak = 0;
      speaking = false; run = 0;
    },
  };
}
