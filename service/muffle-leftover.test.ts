// SHEP-55: SHEP-51's call muffle is rolled back; mods/chat/muffle.ts only puts back what a call that died muffling left
// lowered (its guard in <app home>/data/call-muffle). Run as the installer and old watchers run it, with fake pactl/paplay.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "mods", "chat", "muffle.ts");

function fakes(streams: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "muffle-left-"));
  const app = join(dir, "app"), log = join(dir, "log");
  mkdirSync(join(app, "data", "call-muffle"), { recursive: true });
  writeFileSync(join(dir, "streams.json"), JSON.stringify(streams));
  const pactl = join(dir, "pactl"), paplay = join(dir, "paplay");
  writeFileSync(pactl, `#!/bin/sh\nif [ "$1" = -f ]; then cat "${dir}/streams.json"; else echo "pactl $*" >> "${log}"; fi\n`);
  writeFileSync(paplay, `#!/bin/sh\necho "paplay $*" >> "${log}"\ncat > /dev/null\n`);
  chmodSync(pactl, 0o755); chmodSync(paplay, 0o755);
  return { app, log, guards: join(app, "data", "call-muffle"), env: { ...process.env, HERDR_APP_HOME: app, HERDR_PACTL: pactl, HERDR_PAPLAY: paplay } };
}
const stream = (index: number, vol: number, key = "") =>
  ({ index, volume: { "front-left": { value: vol }, "front-right": { value: vol } }, properties: { "module-stream-restore.id": key } });
async function deadPid() { const p = Bun.spawn(["true"]); await p.exited; return p.pid; }
const restore = (env: Record<string, string | undefined>) =>
  Bun.spawn(["bun", SCRIPT, "restore"], { env, stdout: "ignore", stderr: "ignore" }).exited;

test("a dead call's guard: its muffled streams go back up, a changed one is left, the guard and folder go", async () => {
  const f = fakes([stream(7, 16384), stream(8, 40000)]);
  writeFileSync(join(f.guards, `${await deadPid()}.json`), JSON.stringify({ streams: {
    7: { orig: [65536, 65536], set: [16384, 16384], key: "" },
    8: { orig: [65536, 65536], set: [16384, 16384], key: "" },
  }, gone: {} }));
  expect(await restore(f.env)).toBe(0);
  expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual(["pactl set-sink-input-volume 7 65536 65536"]);
  expect(existsSync(f.guards)).toBe(false);
});

test("an app whose muffled stream ended: its new stream at the muffled volume goes back to its own", async () => {
  const key = "sink-input-by-application-name:Helium";
  const f = fakes([stream(12, 16384, key)]);
  writeFileSync(join(f.guards, `${await deadPid()}.json`), JSON.stringify({ streams: {},
    gone: { [key]: { orig: [50000, 50000], set: [16384, 16384] } } }));
  expect(await restore(f.env)).toBe(0);
  expect(readFileSync(f.log, "utf8").trim()).toBe("pactl set-sink-input-volume 12 50000 50000");
  expect(existsSync(f.guards)).toBe(false);
});

test("a running call's guard stays; a broken guard or none does nothing", async () => {
  const f = fakes([stream(7, 16384)]);
  writeFileSync(join(f.guards, `${process.pid}.json`), JSON.stringify({ streams: { 7: { orig: [65536, 65536], set: [16384, 16384] } } }));
  writeFileSync(join(f.guards, `${await deadPid()}.json`), "{not json");
  expect(await restore(f.env)).toBe(0);
  expect(existsSync(f.log)).toBe(false);
  expect(existsSync(join(f.guards, `${process.pid}.json`))).toBe(true);
  const none = fakes([]);
  expect(await restore({ ...none.env, HERDR_APP_HOME: join(none.app, "nothing") })).toBe(0);
});

test("a stray voice.muffle in the settings file: Settings › Window has no such row, and it can't be set", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "muffle-set-")), "settings.json");
  writeFileSync(file, JSON.stringify({ version: 1, everywhere: { voice: { muffle: 25 } } }));
  const before = process.env.HERDR_TASK_SETTINGS;
  process.env.HERDR_TASK_SETTINGS = file;
  try {
    const { windowSection, setWindow } = await import("./window.ts");
    const rows = windowSection(() => undefined).rows;
    expect(rows.some((r) => r.key === "addon.voice")).toBe(true);
    expect(rows.some((r) => r.key.startsWith("voice."))).toBe(false);
    await expect(setWindow("voice.muffle", "25%", async () => {})).rejects.toThrow();
  } finally {
    if (before === undefined) delete process.env.HERDR_TASK_SETTINGS; else process.env.HERDR_TASK_SETTINGS = before;
  }
});
