// SHEP-51: the call's muffle (core/duck.js) against a fake pactl: which streams, how far and how fast, each put back
// exactly, streams that come and go, a person's own change, the guard after a crash, and the mic's speech gate.
import { expect, test } from "bun:test";
import { parseStreams, ducker, recover, speechGate, muffleLevel, muffleFromWord, MUFFLE, MUFFLE_DEFAULT, CALL_APP, DOWN_MS, UP_MS } from "./duck.js";
import { speakerArgs } from "./audio.js";

const FULL = 65536;
// a fake PipeWire: sink inputs by id, with what PipeWire keeps per app (stream-restore) like the real one
function fakePactl(streams) {
  const s = new Map(streams.map((x) => [x.id, { ...x, vols: [...x.vols] }]));
  const kept = new Map();
  const log = [];
  return {
    s, kept, log,
    add(x) { s.set(x.id, { ...x, vols: [...(kept.get(x.key) ?? x.vols)] }); },
    end(id) { s.delete(id); },
    io: {
      async list() { return [...s.values()].map((x) => ({ ...x, vols: [...x.vols] })); },
      async set(id, vols) { log.push([id, vols]); const x = s.get(id); if (x) { x.vols = [...vols]; if (x.key) kept.set(x.key, [...vols]); } },
      async heal(key, vols) { log.push(["heal", key, vols]); kept.set(key, [...vols]); },
      guard: undefined,
      async save(g) { this.guard = g; },
    },
  };
}
const music = (id = 1, vols = [FULL, FULL]) => ({ id, vols, key: "sink-input-by-application-name:Helium", name: "Helium", skip: false });

async function run(d, want, level, from, to, every = 50) {
  for (let t = from; t <= to; t += every) await d.step(want, level, t);
}

test("pactl's JSON: the call's own sound and virtual streams are never muffled", () => {
  const raw = [
    { index: 7, volume: { "front-left": { value: 65536 }, "front-right": { value: 32768 } },
      properties: { "application.name": "Helium", "module-stream-restore.id": "sink-input-by-application-name:Helium" } },
    { index: 8, volume: { mono: { value: 65536 } }, properties: { "application.name": CALL_APP, "herdr.call": "true" } },
    { index: 9, volume: { "front-left": { value: 65536 } }, properties: { "node.name": "superwhisper_muffle_output", "node.virtual": "true", "node.passive": "true", "node.link-group": "superwhisper-muffle" } },
    { index: "x", volume: {} },
  ];
  const got = parseStreams(JSON.stringify(raw));
  expect(got.map((x) => [x.id, x.skip])).toEqual([[7, false], [8, true], [9, true]]);
  expect(got[0].vols).toEqual([65536, 32768]);
  expect(got[0].key).toBe("sink-input-by-application-name:Helium");
  expect(parseStreams("not json")).toEqual([]);
  // the call's own speaker carries the mark (pw-play's properties) and a phone call's role
  const args = speakerArgs("pipewire", 16000, "herdr-audio", true);
  expect(args).toContain("Communication");
  expect(args.join(" ")).toContain("herdr.call = true");
  expect(args.at(-1)).toBe("-");
  expect(speakerArgs("pipewire", 16000)).not.toContain("Communication");
});

test("down to its share of each stream's own volume in about 250 ms, back up slower, each exactly as it was", async () => {
  const f = fakePactl([music(1, [FULL, 40000]), { ...music(2, [30000]), key: "sink-input-by-media-role:music" },
    { id: 3, vols: [FULL], key: "", name: CALL_APP, skip: true }]);
  const d = ducker(f.io);
  await d.step(false, 0.25, 0);
  expect(f.log).toEqual([]);
  await run(d, true, 0.25, 50, 150);
  expect(d.gain).toBeGreaterThan(0.25);
  await run(d, true, 0.25, 200, 300);
  expect(d.gain).toBe(0.25);
  expect(f.s.get(1).vols).toEqual([16384, 10000]);
  expect(f.s.get(2).vols).toEqual([7500]);
  // the call's own stream: untouched
  expect(f.log.some(([id]) => id === 3)).toBe(false);
  // the guard says what to put back
  expect(f.io.guard.streams[1].orig).toEqual([FULL, 40000]);
  // up: slower than down
  const t0 = 350;
  await run(d, false, 0.25, t0, t0 + DOWN_MS + 50);
  expect(d.gain).toBeLessThan(1);
  await run(d, false, 0.25, t0 + DOWN_MS + 100, t0 + UP_MS + 100);
  expect(d.gain).toBe(1);
  expect(f.s.get(1).vols).toEqual([FULL, 40000]);
  expect(f.s.get(2).vols).toEqual([30000]);
  expect(f.io.guard).toBe(null);
  expect(d.muffled).toBe(0);
});

test("a stream that starts while muffled goes down too; one the person turns meanwhile is theirs", async () => {
  const f = fakePactl([music(1), { ...music(2, [50000]), key: "sink-input-by-application-name:Spotify" }]);
  const d = ducker(f.io);
  await run(d, true, 0.25, 0, 400);
  f.add({ id: 4, vols: [20000, 20000], key: "sink-input-by-application-name:mpv", name: "mpv", skip: false });
  // the person sets Spotify to 60% meanwhile
  f.s.get(2).vols = [39321];
  await run(d, true, 0.25, 450, 1200);
  expect(f.s.get(4).vols).toEqual([5000, 5000]);
  await run(d, false, 0.25, 1250, 3000);
  expect(f.s.get(1).vols).toEqual([FULL, FULL]);
  expect(f.s.get(4).vols).toEqual([20000, 20000]);
  // theirs: never put back over it
  expect(f.s.get(2).vols).toEqual([39321]);
});

test("a stream that ends while muffled: its app's kept volume is put back, and its next stream starts at its own", async () => {
  const f = fakePactl([music(1)]);
  const d = ducker(f.io);
  await run(d, true, 0.25, 0, 400);
  expect(f.kept.get(music().key)).toEqual([16384, 16384]);
  f.end(1);
  await run(d, true, 0.25, 450, 1000);
  // the app plays again: PipeWire starts it at the muffled volume it kept; its own is the one before
  f.add(music(5));
  expect(f.s.get(5).vols).toEqual([16384, 16384]);
  await run(d, true, 0.25, 1050, 1600);
  await run(d, false, 0.25, 1650, 3000);
  expect(f.s.get(5).vols).toEqual([FULL, FULL]);
  // and one that never comes back is healed at the end
  const g = fakePactl([music(1)]);
  const d2 = ducker(g.io);
  await run(d2, true, 0.25, 0, 400);
  g.end(1);
  await run(d2, true, 0.25, 450, 1000);
  await run(d2, false, 0.25, 1050, 3000);
  expect(g.log.filter((x) => x[0] === "heal")).toEqual([["heal", music().key, [FULL, FULL]]]);
  expect(g.kept.get(music().key)).toEqual([FULL, FULL]);
});

test("release at the call's end puts everything back at once", async () => {
  const f = fakePactl([music(1)]);
  const d = ducker(f.io);
  await run(d, true, 0.1, 0, 400);
  expect(f.s.get(1).vols).toEqual([6554, 6554]);
  await d.release();
  expect(f.s.get(1).vols).toEqual([FULL, FULL]);
  expect(f.io.guard).toBe(null);
});

test("after a crash the guard puts back what is still muffled, leaves what the person changed, heals what ended", async () => {
  const guard = { streams: {
    1: { orig: [FULL, FULL], set: [16384, 16384], key: music().key },
    2: { orig: [50000], set: [12500], key: "sink-input-by-application-name:Spotify" },
    3: { orig: [40000], set: [10000], key: "sink-input-by-application-name:mpv" },
  }, gone: {} };
  const f = fakePactl([music(1, [16384, 16384]), { ...music(2, [33000]), key: "sink-input-by-application-name:Spotify" }]);
  const n = await recover(guard, f.io);
  expect(f.s.get(1).vols).toEqual([FULL, FULL]);
  expect(f.s.get(2).vols).toEqual([33000]);
  expect(f.log).toContainEqual(["heal", "sink-input-by-application-name:mpv", [40000]]);
  expect(n).toBe(2);
  expect(f.io.guard).toBe(null);
  expect(await recover(null, f.io)).toBe(0);
});

test("the person speaking: well over the room's own level, twice in a row, kept by a lower line", () => {
  const g = speechGate();
  let t = 0;
  const feed = (rms, frozen = false) => g.feed(rms, (t += 100), frozen);
  // a quiet room, then one loud 100 ms (a cough, a door): not speech
  for (let i = 0; i < 30; i++) feed(100);
  expect(feed(2000)).toBe(false);
  expect(feed(100)).toBe(false);
  // speech: two in a row
  expect(feed(1500)).toBe(false);
  expect(feed(1500)).toBe(true);
  // hysteresis: a softer syllable stays speech, a pause ends it
  expect(feed(500)).toBe(true);
  expect(feed(100)).toBe(false);
  // music fading in, leaking into the mic: the floor rises with it, so the music alone never counts
  for (let i = 0; i < 400; i++) expect(feed(Math.min(900, 100 + i * 10))).toBe(false);
  expect(g.floor).toBeGreaterThan(800);
  // the person over the music does
  feed(4000);
  expect(feed(4000)).toBe(true);
  // while muffled the floor doesn't follow the quieter music (no pumping when it comes back up)
  feed(100);
  const before = g.floor;
  for (let i = 0; i < 50; i++) feed(300, true);
  expect(g.floor).toBe(before);
  // a full-volume leak right after unmuffling: still not speech
  expect(feed(900)).toBe(false);
  expect(feed(900)).toBe(false);
});

test("music that starts loud may muffle once; with no words heard, never again", () => {
  const g = speechGate();
  let t = 0;
  const feed = (rms, frozen = false) => g.feed(rms, (t += 100), frozen);
  for (let i = 0; i < 30; i++) feed(100);
  feed(1200);
  expect(feed(1200)).toBe(true);
  // muffled: the leak drops, the speech ends; the call heard no words: doubt
  for (let i = 0; i < 10; i++) feed(150, true);
  g.doubt();
  // back up, the same music: not speech any more
  for (let i = 0; i < 30; i++) expect(feed(1200)).toBe(false);
  // the person, louder than it: still heard
  feed(5000);
  expect(feed(5000)).toBe(true);
});

test("the setting: on at 25% unless picked; its words", () => {
  expect(muffleLevel(null)).toBe(MUFFLE_DEFAULT);
  expect(MUFFLE_DEFAULT).toBe(25);
  expect(muffleLevel({ everywhere: { voice: { muffle: 0 } } })).toBe(0);
  expect(muffleLevel({ everywhere: { voice: { muffle: 10 } } })).toBe(10);
  expect(muffleLevel({ everywhere: { voice: { muffle: 33 } } })).toBe(25);
  expect(muffleFromWord("Off")).toBe(0);
  expect(muffleFromWord("50%")).toBe(50);
  expect(muffleFromWord("70%")).toBe(null);
  expect(MUFFLE.word(0)).toBe("Off");
  expect(MUFFLE.word(25)).toBe("25%");
});
