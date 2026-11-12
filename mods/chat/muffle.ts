// SHEP-51: a window call's muffle (core/duck.js) on this machine: pactl for the streams and their volumes, the guard
// file that says what to put back, and the putting back after a call that died while muffling.
//   bun muffle.ts restore    puts back what calls that are gone left muffled (their guards); the watcher a call
//                            starts runs it once the call's process is gone, and each call runs it first
// Linux with PipeWire or PulseAudio, and pactl 16 or later (its JSON). Elsewhere: nothing.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseStreams, ducker, recover, muffleLevel } from "./core/duck.js";
import { HOME, shepPaths } from "./key.ts";

const GUARDS = join(HOME, "data", "call-muffle");
// (the tests' fakes)
const PACTL = process.env.HERDR_PACTL || "pactl";
const PAPLAY = process.env.HERDR_PAPLAY || "paplay";
const ONLY = process.env.HERDR_MUFFLE_ONLY ? new RegExp(process.env.HERDR_MUFFLE_ONLY) : null;
const guardFile = (pid: number) => join(GUARDS, `${pid}.json`);

type Stream = { id: number; vols: number[]; key: string; name: string; skip: boolean };
export type Io = { list: () => Promise<Stream[] | null>; set: (id: number, vols: number[]) => Promise<void>;
  heal: (key: string, vols: number[]) => Promise<void>; save: (guard: unknown) => Promise<void> };

async function run(argv: string[], input?: Uint8Array): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdin: input ? "pipe" : "ignore", stdout: "pipe", stderr: "ignore" });
    if (input) { (p.stdin as any).write(input); (p.stdin as any).end(); }
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch { return { code: -1, out: "" }; }
}

/** Is pactl here, and does it speak JSON (16 or later)? */
export async function canMuffle() {
  if (process.platform !== "linux" || !Bun.which(PACTL)) return false;
  const r = await run([PACTL, "-f", "json", "list", "sink-inputs"]);
  return r.code === 0 && r.out.trim().startsWith("[");
}

/** PipeWire remembers an app's volume by its stream-restore key; a moment of silence as that app, set to its old
 *  volume, puts it back (the stream is marked as the call's own, so no muffle takes it). */
async function heal(key: string, vols: number[]) {
  const m = /^sink-input-by-(media-role|application-name|application-id):(.*)$/.exec(key);
  if (!m || !m[2] || !Bun.which(PAPLAY)) return;
  const prop = { "media-role": "media.role", "application-name": "application.name", "application-id": "application.id" }[m[1]]!;
  const ch = Math.max(1, Math.min(8, vols.length));
  const argv = [PAPLAY, "--raw", "--rate=8000", `--channels=${ch}`, "--format=s16le", `--property=${prop}=${m[2]}`,
    "--property=herdr.call=true", ...(prop === "application.name" ? [`--client-name=${m[2]}`] : [])];
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" }); } catch { return; }
  (p.stdin as any).write(new Uint8Array(8000 * 2 * ch * 2)); // 2 s of silence: time to find it and set it
  (p.stdin as any).flush?.();
  for (let i = 0; i < 15; i++) {
    await Bun.sleep(100);
    const r = await run([PACTL, "-f", "json", "list", "sink-inputs"]);
    let raw: any[] = [];
    try { raw = JSON.parse(r.out); } catch {}
    const s = raw.find((x) => String(x?.properties?.["module-stream-restore.id"] ?? "") === key && x?.properties?.["herdr.call"] === "true");
    if (!s) continue;
    const n = Object.keys(s.volume ?? {}).length;
    await run([PACTL, "set-sink-input-volume", String(s.index), ...(n === vols.length ? vols : Array(n).fill(vols[0])).map(String)]);
    await Bun.sleep(300);
    break;
  }
  try { p.kill(); } catch {}
}

/** pactl as the duck controller's io; the guard kept for pid. */
export function pactlIo(pid = process.pid): Io {
  return {
    async list() {
      const r = await run([PACTL, "-f", "json", "list", "sink-inputs"]);
      if (r.code !== 0) return null;
      const all = parseStreams(r.out) as Stream[];
      // (a live try on a machine whose own sound must stay as it is: only the apps named so)
      return ONLY ? all.filter((s) => ONLY.test(s.name)) : all;
    },
    async set(id, vols) { await run([PACTL, "set-sink-input-volume", String(id), ...vols.map(String)]); },
    heal,
    async save(guard) {
      const f = guardFile(pid);
      try {
        if (!guard) { rmSync(f, { force: true }); return; }
        mkdirSync(GUARDS, { recursive: true });
        writeFileSync(`${f}.tmp`, JSON.stringify(guard));
        renameSync(`${f}.tmp`, f);
      } catch {}
    },
  };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** What calls that are gone left muffled, put back (each guard whose process isn't running). */
export async function restoreLeft(except = process.pid) {
  let files: string[] = [];
  try { files = readdirSync(GUARDS).filter((f) => /^\d+\.json$/.test(f)); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const pid = Number(f.split(".")[0]);
    if (pid === except || alive(pid)) continue;
    let guard: unknown = null;
    try { guard = JSON.parse(readFileSync(join(GUARDS, f), "utf8")); } catch {}
    n += await recover(guard, pactlIo(pid));
    try { rmSync(join(GUARDS, f), { force: true }); } catch {}
  }
  return n;
}

/** The level Settings picks now (0..1; 0 off). */
export function levelNow() {
  try { return muffleLevel(JSON.parse(readFileSync(shepPaths().settings, "utf8"))) / 100; } catch { return muffleLevel(null) / 100; }
}

/** A call's muffle: null when this machine can't. tick(want) once a tick (each waits for the last), release() at the
 *  end. Starts a watcher that puts things back if this process dies without it. */
export async function startMuffle() {
  if (!(await canMuffle())) return null;
  await restoreLeft();
  const io = pactlIo();
  const d = ducker(io);
  try {
    Bun.spawn(["sh", "-c", 'command -v setsid >/dev/null 2>&1 && exec setsid sh -c "$0" x "$@" || exec sh -c "$0" x "$@"',
      'while kill -0 "$1" 2>/dev/null; do sleep 2; done; [ -s "$3" ] && exec bun "$2" restore; exit 0',
      String(process.pid), join(import.meta.dir, "muffle.ts"), guardFile(process.pid)],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
  } catch {}
  let busy: Promise<void> | null = null;
  let level = levelNow(), readAt = Date.now();
  return {
    get gain() { return d.gain; },
    tick(want: boolean) {
      if (busy) return;
      const now = Date.now();
      // a change in Settings applies within a couple of seconds
      if (now - readAt > 2000) { readAt = now; level = levelNow(); }
      busy = d.step(want, level, now).catch(() => {}).finally(() => { busy = null; });
    },
    async release() {
      try { await busy; } catch {}
      await d.release().catch(() => {});
    },
  };
}

if (import.meta.main && process.argv[2] === "restore") {
  const n = await restoreLeft();
  if (n) console.error(`muffle: put back ${n} stream${n === 1 ? "" : "s"}`);
}
