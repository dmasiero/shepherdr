// SHEP-51: the window call's muffle on a machine (mods/chat/muffle.ts) against a fake pactl: its JSON read, volumes set
// per channel, and `bun muffle.ts restore` putting back what a call that died left muffled (its guard).
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MUFFLE = join(import.meta.dir, "..", "mods", "chat", "muffle.ts");

// pactl as a script over a JSON file of sink inputs: `-f json list sink-inputs` and `set-sink-input-volume <id> <v>...`
function fake() {
  const dir = mkdtempSync(join(tmpdir(), "muffle-"));
  const state = join(dir, "streams.json");
  const pactl = join(dir, "pactl");
  writeFileSync(pactl, `#!/usr/bin/env python3
import json, sys
f = ${JSON.stringify(state)}
s = json.load(open(f))
a = sys.argv[1:]
if a[:4] == ["-f", "json", "list", "sink-inputs"]:
    print(json.dumps(s)); sys.exit(0)
if a and a[0] == "set-sink-input-volume":
    for x in s:
        if str(x["index"]) == a[1]:
            for k, v in zip(list(x["volume"]), a[2:]): x["volume"][k]["value"] = int(v)
    json.dump(s, open(f, "w")); sys.exit(0)
sys.exit(1)
`);
  chmodSync(pactl, 0o755);
  const stream = (index, name, vols, extra = {}) => ({ index, volume: Object.fromEntries(vols.map((v, i) => [["front-left", "front-right"][i], { value: v }])),
    properties: { "application.name": name, "module-stream-restore.id": `sink-input-by-application-name:${name}`, ...extra } });
  return { dir, pactl, state, stream,
    write: (list) => writeFileSync(state, JSON.stringify(list)),
    vols: (id) => Object.values(JSON.parse(readFileSync(state, "utf8")).find((x) => x.index === id).volume).map((c) => c.value) };
}

test("restore after a crash: the dead call's guard put back through pactl, a live call's left alone", async () => {
  const f = fake();
  f.write([f.stream(11, "Helium", [16384, 16384]), f.stream(12, "Spotify", [30000, 30000]), f.stream(13, "Herdr call", [65536], { "herdr.call": "true" })]);
  const home = join(f.dir, "app");
  mkdirSync(join(home, "data", "call-muffle"), { recursive: true });
  // a pid that can't be running, and this test's own (alive: its guard stays)
  const dead = join(home, "data", "call-muffle", "999999999.json");
  writeFileSync(dead, JSON.stringify({ streams: {
    11: { orig: [65536, 65536], set: [16384, 16384], key: "sink-input-by-application-name:Helium" },
    12: { orig: [65536, 65536], set: [16384, 16384], key: "sink-input-by-application-name:Spotify" },
  }, gone: {} }));
  const live = join(home, "data", "call-muffle", `${process.pid}.json`);
  writeFileSync(live, JSON.stringify({ streams: { 12: { orig: [1, 1], set: [30000, 30000], key: "x" } }, gone: {} }));
  const p = Bun.spawn(["bun", MUFFLE, "restore"], { env: { ...process.env, HERDR_APP_HOME: home, HERDR_PACTL: f.pactl, HERDR_PAPLAY: join(f.dir, "none") }, stderr: "pipe" });
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stderr).text()).toContain("put back 1 stream");
  // Helium: back to its own; Spotify: the person set it meanwhile, left as they put it
  expect(f.vols(11)).toEqual([65536, 65536]);
  expect(f.vols(12)).toEqual([30000, 30000]);
  expect(f.vols(13)).toEqual([65536]);
  expect(existsSync(dead)).toBe(false);
  expect(existsSync(live)).toBe(true);
  rmSync(f.dir, { recursive: true, force: true });
});

test("pactl as the muffle's io: streams read, the call's own skipped, volumes set per channel", async () => {
  const f = fake();
  f.write([f.stream(21, "mpv", [40000, 20000]), f.stream(22, "Herdr call", [65536], { "herdr.call": "true" })]);
  // read once at import (bun runs every test file in one process: put them back after)
  const was = { p: process.env.HERDR_PACTL, h: process.env.HERDR_APP_HOME };
  process.env.HERDR_PACTL = f.pactl;
  process.env.HERDR_APP_HOME = join(f.dir, "app");
  const { pactlIo, canMuffle } = await import("../mods/chat/muffle.ts");
  for (const [k, v] of [["HERDR_PACTL", was.p], ["HERDR_APP_HOME", was.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  if (process.platform === "linux") expect(await canMuffle()).toBe(true);
  const io = pactlIo(123);
  const list = await io.list();
  expect(list.map((s) => [s.id, s.skip])).toEqual([[21, false], [22, true]]);
  await io.set(21, [10000, 5000]);
  expect(f.vols(21)).toEqual([10000, 5000]);
  await io.save({ streams: { 21: { orig: [40000, 20000], set: [10000, 5000], key: "k" } }, gone: {} });
  expect(existsSync(join(f.dir, "app", "data", "call-muffle", "123.json"))).toBe(true);
  await io.save(null);
  expect(existsSync(join(f.dir, "app", "data", "call-muffle", "123.json"))).toBe(false);
  rmSync(f.dir, { recursive: true, force: true });
});
