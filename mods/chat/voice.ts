// A voice call from the Herdr window: the same call as the web app's (SHEP-57), held by this machine's Shepherdr service
// (service/voice.ts over /api/voice: the ElevenLabs voice agent, its tools, what it hears, the person's yes before
// it hangs up), with this machine's microphone and speaker instead of a phone's. This helper only carries the sound
// both ways and links the call to the chat that started it; the window shows the call (Mute, End, the wave). Started
// by the chat mod (a mod has no audio or sockets); one process per call, nothing recorded or kept.
//   bun voice.ts <call folder> <agent address> <agent name>
// The call folder links it to the chat:
//   state.json  written here: { phase, doing, who, muted, error, since, pid, said } (phase: connecting, listening,
//               thinking, working (doing: what, in plain words), speaking, ended)
//   alive       touched by the chat every few seconds; stale for 20 s ends the call
//   in/*.json   from the chat: { type: "mute", on } | { type: "hangup" } (other kinds are let go)
//   where.json  from the chat: what the window shows ({ place, task, tab }), the call's "here"
//   nav/*.json  written here: what the voice agent asked to show (open, the screen tool), done by the chat
//   navved/*.json  from the chat, by the nav's name: { ok, why, did?, ask?, screen? } once it tried it
// and beside it <call folder>.level: how loud the call is now, 0..1 (the agent while it speaks, else the person), for
// the chat's wave.
// The service is found as the window finds it (service.json's port and id, its local token): without it there is no
// call, and the window says so. The ElevenLabs key never comes here.

import { readFileSync, writeFileSync, readdirSync, rmSync, statSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { chimePcm } from "./core/voice.js";
import { shepPaths } from "./key.ts";
import { audio, callAudio, ended as audioEnded, type Audio, type CallSound } from "./audio.ts";

const [dir, addr] = process.argv.slice(2);
if (!dir || !addr) { console.error("usage: bun voice.ts <call folder> <agent address> <agent name>"); process.exit(2); }

/** the voice agent plays and records at 16 kHz (service/voice.ts makes sure) */
const RATE = 16000;
/** a call's socket that drops comes back to the call the service holds for it, for this long (SHEP-102) */
const HOLD_MS = 55_000;
const NO_SERVICE = "Shepherdr's service isn't running on this machine, so the call can't start (shepherdr doctor says why).";

let ended = false;
let ws: WebSocket | null = null;
let callId = "";
let muted = false;
let phase = "connecting";
const since = Date.now();
let error: string | null = null;
let phaseAt = 0;
let heardAt = 0;
let doing = "";
// the last thing the voice said (the sidebar's call card shows it)
let said = "";

function state() {
  const speaking = Date.now() < playEnd + 250;
  const shown = ended ? "ended" : phase === "connecting" ? "connecting" : speaking ? "speaking"
    : phase === "thinking" && Date.now() - phaseAt < 20000 ? "thinking" : phase === "working" && Date.now() - phaseAt < 35000 ? "working" : "listening";
  // Who is talking, for the chat's wave: the agent while its voice plays, else the person
  // while the microphone hears them (a moment's hold, so it doesn't flicker).
  const talking = ended ? null : speaking ? "agent" : !muted && Date.now() - heardAt < 400 ? "you" : null;
  const s = JSON.stringify({ phase: shown, doing: shown === "working" ? doing : "", who: talking, muted, error, since, pid: process.pid, said });
  if (s === lastState) return;
  lastState = s;
  try { writeFileSync(join(dir, "state.json.tmp"), s); renameSync(join(dir, "state.json.tmp"), join(dir, "state.json")); } catch {}
}
let lastState = "";

/** The call ends here: why (none: the person or the voice hung up). told: the service already knows (else it's told). */
function end(why: string | null = null, told = false) {
  if (ended) return;
  if (why) error = why;
  ended = true;
  if (!told) send({ type: "end" });
  try { ws?.close(); } catch {}
  sound?.stop(); asking?.kill();
  state();
  // SHEP-173: the end chime, at the system's volume, whatever ended it; then this helper goes
  const chimed = chime();
  setTimeout(() => process.exit(0), chimed ? 900 : 100);
}

/** The end chime through the speaker (audio.ts), when this machine has one: true when it plays. */
function chime() {
  if (!tools) return false;
  try {
    const p = Bun.spawn(tools.speaker(RATE), { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const pcm = chimePcm(RATE) as Int16Array;
    p.stdin.write(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    p.stdin.end();
    return true;
  } catch { return false; }
}
process.on("SIGTERM", () => end());
process.on("SIGINT", () => end());

// ---- the service --------------------------------------------------------------------------

const DATA = process.env.SHEPHERDR_DATA || shepPaths().service;

/** The service's address, only when Shepherdr's own service answers there (service.json's port and id, as the window's
 *  lib/local.js): never the token to another app on its port. */
async function service(): Promise<string | null> {
  try {
    const f = JSON.parse(readFileSync(join(DATA, "service.json"), "utf8"));
    const base = `http://127.0.0.1:${f.port}`;
    const h = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).json();
    return typeof f.id === "string" && f.id && h?.id === f.id ? base : null;
  } catch { return null; }
}

function where(): Record<string, unknown> { try { return JSON.parse(readFileSync(join(dir, "where.json"), "utf8")) ?? {}; } catch { return {}; } }

function send(m: object) {
  if (ws?.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(m)); } catch {}
}

// ---- audio --------------------------------------------------------------------------------

// the call's mic and speaker (audio.ts callAudio): on a Mac echo-free, so the mic stays open while the agent speaks
let sound: CallSound | null = null;
let playEnd = 0;
// pw-record and pw-play, or the Mac's own (audio.ts), found before the call connects
let tools: Audio | null = null;
// macOS's microphone prompt, while it shows (a hang-up meanwhile ends it)
let asking: ReturnType<typeof Bun.spawn> | null = null;

// Loudness of 16-bit samples, scaled so speech fills most of 0..1.
function loud(pcm: Uint8Array) {
  const s = new Int16Array(pcm.slice(0, pcm.length & ~1).buffer);
  let sum = 0;
  for (let i = 0; i < s.length; i += 2) sum += s[i] * s[i];
  return Math.min(1, (Math.sqrt(sum / Math.max(1, s.length >> 1)) / 32768) * 8);
}
// The agent's voice as it will be heard: 100 ms pieces with when they play and how loud.
let heard: { at: number; level: number }[] = [];
let micLevel = 0;

function play(pcm: Uint8Array) {
  if (!sound) return;
  const now = Date.now();
  const from = Math.max(playEnd, now + 120);
  const piece = Math.round(RATE * 2 * 0.1);
  for (let i = 0; i < pcm.length; i += piece) heard.push({ at: from + (i / 2 / RATE) * 1000, level: loud(pcm.subarray(i, i + piece)) });
  if (heard.length > 3000) heard = heard.slice(-3000);
  playEnd = from + (pcm.length / 2 / RATE) * 1000;
  sound.play(pcm);
  state();
}
// Talked over: what it was going to say is dropped.
function hush() {
  sound?.drop();
  playEnd = 0;
  heard = [];
  state();
}

function startSound() {
  const chunk = Math.round(RATE * 2 * 0.1); // 100 ms
  let buf = new Uint8Array(0);
  sound = callAudio(tools!, RATE, RATE, {
    failed: (why) => end(why),
    // (quietly: the call goes on the old way, only a line for whoever reads the log)
    fellBack: (why) => { if (why) console.error(`voice: no echo cancellation, the mic hushes while the agent speaks (${why})`); },
    heard(part) {
      if (ended) return;
      const next = new Uint8Array(buf.length + part.length);
      next.set(buf); next.set(part, buf.length);
      buf = next;
      while (buf.length >= chunk) {
        let piece = buf.slice(0, chunk);
        buf = buf.slice(chunk);
        // Without echo cancellation, the agent's own voice comes back through the mic: while it plays (and a moment
        // after) the mic means nothing and the voice agent hears silence instead. With it (a Mac's call), the person
        // can talk over the agent.
        const hushed = !sound?.echoFree() && Date.now() < playEnd + 350;
        // Loud enough to be speech (RMS above ~2% of full scale): the person is talking.
        const pcm = new Int16Array(piece.buffer, piece.byteOffset, piece.length >> 1);
        let sum = 0;
        for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
        if (Math.sqrt(sum / Math.max(1, pcm.length >> 2)) > 650 && !hushed) heardAt = Date.now();
        micLevel = loud(piece);
        // muted: nothing goes, as the web app's call (the socket's keep-alive holds it)
        if (muted) continue;
        if (hushed) piece = new Uint8Array(chunk);
        if (ws?.readyState === WebSocket.OPEN) try { ws.send(piece); } catch {}
      }
    },
  });
}

// ---- the chat -----------------------------------------------------------------------------

/** What the voice agent asked to show, done by the chat that started this call: its { ok, why } (a screen action's
 *  { did, ask, screen } too), or null when it didn't answer in time (the chat reads nav/ about once a second). */
async function showHere(nav: unknown): Promise<{ ok: boolean; why?: string; did?: string; ask?: string; screen?: string } | null> {
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.json`;
  try {
    mkdirSync(join(dir, "nav"), { recursive: true });
    writeFileSync(join(dir, "nav", `${name}.tmp`), JSON.stringify(nav));
    renameSync(join(dir, "nav", `${name}.tmp`), join(dir, "nav", name));
  } catch { return { ok: false, why: "the window couldn't be told" }; }
  const ack = join(dir, "navved", name);
  for (let i = 0; i < 40 && !ended; i++) {
    await Bun.sleep(150);
    let a: any = null;
    try { a = JSON.parse(readFileSync(ack, "utf8")); } catch { continue; }
    try { rmSync(ack); } catch {}
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return { ok: a?.ok === true, why: str(a?.why), did: str(a?.did), ask: str(a?.ask), screen: str(a?.screen) };
  }
  try { rmSync(join(dir, "nav", name)); } catch {}
  return null;
}

function inbox() {
  const box = join(dir, "in");
  let files: string[] = [];
  try { files = readdirSync(box).filter((f) => f.endsWith(".json")).sort(); } catch { return; }
  for (const f of files) {
    let m: any = null;
    try { m = JSON.parse(readFileSync(join(box, f), "utf8")); } catch {}
    try { rmSync(join(box, f)); } catch {}
    if (!m) continue;
    if (m.type === "hangup") return end();
    if (m.type === "mute") { muted = Boolean(m.on); state(); }
  }
}

// The window moved during the call: the service tells the voice agent once it settles.
let saidWhere = "";
function moved() {
  const w = where(), now = JSON.stringify(w);
  if (now === saidWhere) return;
  saidWhere = now;
  send({ type: "where", ...w });
}

// ---- the call -----------------------------------------------------------------------------

/** One message from the service's call (service/voice.ts: what the web page gets). */
async function message(data: unknown) {
  if (ended) return;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    const pcm = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
    // its voice: done thinking (a word before a tool, "On it.", leaves it working)
    if (phase === "thinking" || phase === "connecting") { phase = "listening"; phaseAt = Date.now(); }
    if (pcm.length % 2 === 0) play(pcm.slice());
    return;
  }
  let m: any = null;
  try { m = JSON.parse(String(data)); } catch { return; }
  if (m?.type === "call" && typeof m.id === "string") callId = m.id;
  else if (m?.type === "resumed") { phase = "listening"; phaseAt = Date.now(); state(); }
  else if (m?.type === "state" && typeof m.state === "string") {
    phase = m.state;
    phaseAt = Date.now();
    doing = m.state === "working" && typeof m.doing === "string" ? m.doing.slice(0, 60) : "";
    state();
  }
  else if (m?.type === "said" && typeof m.text === "string") { said = m.text.slice(0, 300); state(); }
  else if (m?.type === "interrupt") { hush(); phase = "listening"; state(); }
  // an open or a screen action: this window's chat does it and says so, before the agent may say it's on screen
  else if (m?.type === "nav" && m.nav) {
    const ack = await showHere(m.nav) ?? { ok: false, why: "the window didn't answer in time" };
    if (typeof m.id === "number") send({ type: "navved", id: m.id, ...ack, where: where() });
  }
  // the voice agent ended it (the person's yes: no note; else why in plain words, with Call again): its last words
  // play out first
  else if (m?.type === "ended") {
    const why = typeof m.why === "string" && m.why ? `Call ended: ${m.why.slice(0, 200)}.` : null;
    over = true;
    setTimeout(() => end(why, true), Math.max(0, Math.min(10000, playEnd - Date.now() + 300)));
  }
  else if (m?.type === "error") end(typeof m.message === "string" ? m.message.slice(0, 300) : "The voice call could not start.", true);
}
let over = false;

/** The call's socket to the service: the first, or again after a drop (resume: back to the call it holds). */
async function connect(resume: boolean): Promise<boolean> {
  const base = await service();
  let token = "";
  try { token = readFileSync(join(DATA, "token"), "utf8").trim(); } catch {}
  if (!base || !token) return false;
  const q = new URLSearchParams({ client: "window", addr, where: JSON.stringify(where()) });
  if (resume && callId) q.set("resume", callId);
  const sock = new WebSocket(`${base.replace(/^http/, "ws")}/api/voice?${q}`, { headers: { authorization: `Bearer ${token}` } } as any);
  sock.binaryType = "arraybuffer";
  ws = sock;
  return new Promise((res) => {
    let opened = false;
    sock.onopen = () => { opened = true; saidWhere = JSON.stringify(where()); res(true); };
    sock.onmessage = (e) => { if (ws === sock) void message(e.data); };
    sock.onerror = () => {};
    sock.onclose = () => {
      if (!opened) return res(false);
      if (ws === sock) void dropped();
    };
  });
}

/** The socket went without an end: back to the call the service holds (SHEP-102), or the call is over. */
async function dropped() {
  ws = null;
  if (ended || over) return;
  const until = Date.now() + HOLD_MS;
  while (!ended && Date.now() < until) {
    await Bun.sleep(1500);
    if (!ended && (await connect(true))) return;
  }
  end("The call lost Shepherdr's service on this machine.", true);
}

async function main() {
  mkdirSync(join(dir, "in"), { recursive: true });
  state();
  // the service first: without it there is no call
  if (!(await service())) return end(NO_SERVICE, true);
  // The mic and speaker: on a Mac, macOS asks for the microphone now (the first time), before the voice agent starts
  // talking; not allowed, or nothing to record or play with, ends the call with why.
  try { tools = await audio(); } catch (err: any) { return end(String(err?.message ?? err), true); }
  if (tools.access) {
    const p = asking = Bun.spawn(tools.access, { stdout: "ignore", stderr: "pipe" });
    const why = audioEnded("mic", await p.exited, await new Response(p.stderr).text().catch(() => ""));
    asking = null;
    if (why) return end(why, true);
  }
  if (ended) return;
  if (!(await connect(false))) return end(NO_SERVICE, true);
  try { startSound(); } catch (err: any) { end(`The microphone didn't start: ${err?.message ?? err}`); }
}

// The level the chat's wave shows, ten times a second, beside the call folder (so writing it
// doesn't wake the chat's watch on the folder): the agent's voice while it plays, else the mic.
setInterval(() => {
  if (ended) return;
  const now = Date.now();
  let level = 0;
  if (now < playEnd + 100) {
    while (heard.length > 1 && heard[1].at <= now) heard.shift();
    level = heard[0] && heard[0].at <= now ? heard[0].level : 0;
  } else if (!muted) level = micLevel;
  try { writeFileSync(`${dir.replace(/\/$/, "")}.level`, level.toFixed(3)); } catch {}
}, 100);

// The chat's commands, where the window is, and the call's end once the chat stops showing.
setInterval(() => {
  if (ended) return;
  inbox();
  if (ws?.readyState === WebSocket.OPEN) moved();
  try { if (Date.now() - statSync(join(dir, "alive")).mtimeMs > 20000) end(); } catch { if (Date.now() - since > 20000) end(); }
  state();
}, 150);

// SHEP-173: a muted call sends nothing; a word now and then keeps the socket from being taken for idle
setInterval(() => send({ type: "keep" }), 20_000);

main().catch((err) => end(String(err?.message ?? err)));
