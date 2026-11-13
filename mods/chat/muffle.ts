// SHEP-55: what is left of SHEP-51's "Muffle other audio during calls", rolled back. That window call (Linux) lowered
// other apps' playback streams and kept a guard file per call (<app home>/data/call-muffle/<pid>.json: each stream's
// own volume and the one it set), with a watcher that ran `bun muffle.ts restore` once the call's process was gone.
// Nothing muffles now; this only puts back what such a call left lowered:
//   bun muffle.ts restore    each guard whose call is gone: a stream still at the muffled volume back to its own (one
//                            changed since is left), an ended stream's app's remembered volume healed; then the guard
//                            and its folder go
// The installer runs it on an update when guards are there; a call that was running across the update still has its
// watcher, which runs this file by its path. It can go once no install can hold a guard any more.

import { readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./key.ts";

const GUARDS = join(HOME, "data", "call-muffle");
// (the tests' fakes)
const PACTL = process.env.HERDR_PACTL || "pactl";
const PAPLAY = process.env.HERDR_PAPLAY || "paplay";
// A stream changed by someone else by more than this (of 65536, the full volume) is theirs.
const SLACK = 700;

type Stream = { id: number; vols: number[]; key: string; ours: boolean };
type Kept = { orig?: unknown; set?: unknown; key?: unknown };

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch { return { code: -1, out: "" }; }
}

async function raw(): Promise<any[]> {
  const r = await run([PACTL, "-f", "json", "list", "sink-inputs"]);
  try { const l = JSON.parse(r.out); return Array.isArray(l) ? l : []; } catch { return []; }
}

/** The playback streams now: id, each channel's volume, the key PipeWire remembers its volume by. */
async function streams(): Promise<Stream[]> {
  const out: Stream[] = [];
  for (const s of await raw()) {
    const id = Number(s?.index);
    const vols = Object.values(s?.volume ?? {}).map((c: any) => Number(c?.value));
    if (!Number.isInteger(id) || !vols.length || vols.some((v) => !Number.isFinite(v))) continue;
    const p = s.properties ?? {};
    out.push({ id, vols, key: String(p["module-stream-restore.id"] ?? ""), ours: p["herdr.call"] === true || p["herdr.call"] === "true" });
  }
  return out;
}

const nums = (v: unknown): number[] | null =>
  Array.isArray(v) && v.length && v.every((x) => Number.isFinite(x)) ? (v as number[]) : null;
const near = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= SLACK);
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const setVolume = (id: number, vols: number[]) => run([PACTL, "set-sink-input-volume", String(id), ...vols.map(String)]);

/** PipeWire remembers an app's volume by its stream-restore key: a moment of silence played as that app, set to its
 *  own volume, puts it back. */
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
    const s = (await raw()).find((x) => String(x?.properties?.["module-stream-restore.id"] ?? "") === key && x?.properties?.["herdr.call"] === "true");
    if (!s) continue;
    const n = Object.keys(s.volume ?? {}).length;
    await setVolume(Number(s.index), n === vols.length ? vols : Array(n).fill(vols[0]));
    await Bun.sleep(300);
    break;
  }
  try { p.kill(); } catch {}
}

/** One guard put back: how many streams or apps it touched. */
async function recover(guard: any, now: Stream[]) {
  if (!guard || typeof guard !== "object") return 0;
  let n = 0;
  const left = new Map<string, Kept>(Object.entries(guard.gone ?? {}) as [string, Kept][]);
  for (const [id, s] of Object.entries(guard.streams ?? {}) as [string, Kept][]) {
    const orig = nums(s?.orig), set = nums(s?.set);
    if (!orig || !set || same(set, orig)) continue;
    const here = now.find((x) => x.id === Number(id));
    if (here) { if (near(here.vols, set)) { await setVolume(here.id, orig); n++; } }
    else if (typeof s.key === "string" && s.key) left.set(s.key, { orig, set });
  }
  for (const [key, s] of left) {
    const orig = nums(s?.orig), set = nums(s?.set);
    if (!orig) continue;
    // a new stream of that app, at the muffled volume PipeWire gave it: back to its own too
    const again = set && now.find((x) => !x.ours && x.key === key && near(x.vols, set) && x.vols.length === orig.length);
    if (again) await setVolume(again.id, orig);
    else await heal(key, orig);
    n++;
  }
  return n;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** Every guard whose call is gone, put back and removed; the folder too once empty. */
export async function restoreLeft() {
  let files: string[] = [];
  try { files = readdirSync(GUARDS).filter((f) => /^\d+\.json$/.test(f)); } catch { return 0; }
  let n = 0;
  const now = files.length ? await streams() : [];
  for (const f of files) {
    const pid = Number(f.split(".")[0]);
    if (pid !== process.pid && alive(pid)) continue;
    let guard: unknown = null;
    try { guard = JSON.parse(readFileSync(join(GUARDS, f), "utf8")); } catch {}
    try { n += await recover(guard, now); } catch {}
    try { rmSync(join(GUARDS, f), { force: true }); } catch {}
  }
  for (const f of (() => { try { return readdirSync(GUARDS); } catch { return []; } })())
    if (/^\d+\.json\.tmp$/.test(f) && !alive(Number(f.split(".")[0]))) try { rmSync(join(GUARDS, f), { force: true }); } catch {}
  try { rmdirSync(GUARDS); } catch {}
  return n;
}

if (import.meta.main && process.argv[2] === "restore") {
  const n = await restoreLeft();
  if (n) console.error(`muffle: put back ${n} stream${n === 1 ? "" : "s"}`);
}
