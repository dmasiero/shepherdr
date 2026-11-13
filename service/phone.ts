// SHEP-44: a phone call with Shepherdr through the person's Asterisk PBX: the same call as the web's (voice.ts
// voiceCall: the ElevenLabs voice agent, its tools and what it hears), with a phone line for its page. Asterisk's
// AudioSocket (dialplan `AudioSocket(<uuid>,<host>:<port>)`) connects here over TCP; each frame is a 1-byte type, a
// 2-byte big-endian length and the payload: 0x01 the call's uuid, 0x10 audio (slin: 8 kHz 16-bit mono, 20 ms
// frames), 0x03 a DTMF digit (newer Asterisk), 0x00 hangup, 0xff an error.
// Off by default; on in <config>/phone.json (docs/phone.md). Only the PBX addresses it names may connect; the caller
// is checked by the PBX itself (an access code in the dialplan before AudioSocket), so an allowed connection goes
// straight into the call, as the web app's call button does. The call has no screen: its "here" is this machine's Home
// Assistant. Nothing is recorded; audio and keys are never logged.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { where as paths } from "./paths.ts";
import type { Where } from "./voice-tools.ts";

export const T = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff } as const;
/** 20 ms of 8 kHz 16-bit mono */
export const FRAME_BYTES = 320;
export const FRAME_MS = 20;
/** how long Asterisk has to send the call's uuid (its first frame) before the line is hung up */
export const UUID_WAIT_MS = 5_000;

/** One frame, as Asterisk reads it. */
export function frame(type: number, payload: Uint8Array = new Uint8Array(0)) {
  const out = new Uint8Array(3 + payload.length);
  out[0] = type; out[1] = payload.length >> 8; out[2] = payload.length & 0xff;
  out.set(payload, 3);
  return out;
}

/** Frames out of a TCP stream: push() what came, get the whole frames; a partial one waits for the rest. */
export function framer() {
  let buf = new Uint8Array(0);
  return (chunk: Uint8Array) => {
    const all = new Uint8Array(buf.length + chunk.length);
    all.set(buf); all.set(chunk, buf.length);
    const out: { type: number; payload: Uint8Array }[] = [];
    let i = 0;
    while (all.length - i >= 3) {
      const n = (all[i + 1] << 8) | all[i + 2];
      if (all.length - i < 3 + n) break;
      out.push({ type: all[i], payload: all.slice(i + 3, i + 3 + n) });
      i += 3 + n;
    }
    buf = all.slice(i);
    return out;
  };
}

/** The uuid frame's 16 bytes in their usual words (8-4-4-4-12, lower case). */
export function uuidOf(b: Uint8Array) {
  if (b.length !== 16) return "";
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const samples = (b: Uint8Array) => { const c = b.byteOffset % 2 ? b.slice() : b; return new Int16Array(c.buffer, c.byteOffset, c.length >> 1); };
const bytes = (s: Int16Array) => new Uint8Array(s.buffer, s.byteOffset, s.byteLength);

/** The phone's 8 kHz to the voice agent's 16 kHz: each sample, then the halfway to the next (the last held). */
export function up8to16(pcm: Uint8Array) {
  const s = samples(pcm), out = new Int16Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    out[2 * i] = s[i];
    out[2 * i + 1] = i + 1 < s.length ? (s[i] + s[i + 1]) >> 1 : s[i];
  }
  return bytes(out);
}

/** The voice agent's 16 kHz to the phone's 8 kHz: each pair averaged (a plain low-pass, so it doesn't alias). */
export function down16to8(pcm: Uint8Array) {
  const s = samples(pcm), out = new Int16Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (s[2 * i] + s[2 * i + 1]) >> 1;
  return bytes(out);
}

export type PhoneConfig = { on: boolean; port: number; bind: string; pbx: string[] };
export const DEFAULT_PORT = 9092;
/** The phone's setting: <config>/phone.json beside settings.json, this machine's own (never pushed to others). */
export const phoneFile = () => process.env.SHEPHERDR_PHONE_FILE || join(dirname(paths().settings), "phone.json");

/** The setting as it is, checked: off unless it says on and names at least one PBX address. bind "tailnet" (the
 *  default): this machine's Tailscale address; 0.0.0.0 only when written out. */
export function readPhone(file = phoneFile()): PhoneConfig | { on: false; why?: string } {
  if (!existsSync(file)) return { on: false };
  let c: any;
  try { c = JSON.parse(readFileSync(file, "utf8")); } catch { return { on: false, why: `${file} isn't valid JSON` }; }
  if (!c || c.on !== true) return { on: false };
  const pbx = (Array.isArray(c.pbx) ? c.pbx : typeof c.pbx === "string" ? [c.pbx] : []).filter((x: unknown) => typeof x === "string" && x.trim()).map((x: string) => plain(x.trim()));
  if (!pbx.length) return { on: false, why: "phone.json names no pbx address to take calls from" };
  const port = Number(c.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { on: false, why: "phone.json's port isn't a port" };
  const bind = typeof c.bind === "string" && c.bind.trim() ? c.bind.trim() : "tailnet";
  return { on: true, port, bind, pbx };
}

/** An address as compared: an IPv4 one mapped into IPv6 (::ffff:1.2.3.4) as its IPv4 self. */
export const plain = (ip: string) => ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1").toLowerCase();

/** This machine's Tailscale IPv4 address, or null. */
export async function tailnetIP(): Promise<string | null> {
  try {
    const p = Bun.spawn(["tailscale", "ip", "-4"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? out.trim().split("\n")[0] || null : null;
  } catch { return null; }
}

/** What a phone line says to the call (voice.ts's Page): the voice's 16 kHz audio goes out as 8 kHz frames, paced. */
export type Line = { write(b: Uint8Array): void; end(): void };
export type Call = { message(d: string | Buffer | ArrayBuffer): void; end(): void };
export type PhoneDeps = {
  /** the call itself (voice.ts voiceCall, with this page and where) */
  start: (where: Where, page: { send(x: string | Uint8Array): void; close(): void }) => Call;
  /** where the call is: no screen, this machine's Home Assistant its "here" */
  where: () => Where;
  log?: (line: string) => void;
  uuidWait?: number;
};

/** The AudioSocket session on one connection, once its address is allowed: the call starts with Asterisk's first
 *  frame (the uuid); the PBX checked the caller before it connected. */
export function phoneSession(line: Line, deps: PhoneDeps) {
  const log = deps.log ?? ((l: string) => console.error(`phone: ${l}`));
  let state: "uuid" | "call" | "done" = "uuid";
  let call: Call | null = null;
  // what the voice says, as 8 kHz frames sent one per 20 ms (Asterisk plays what comes as it comes)
  let out: Uint8Array[] = [], rest = new Uint8Array(0), closing = false;
  const pump = setInterval(() => {
    const f = out.shift();
    if (f) { try { line.write(frame(T.AUDIO, f)); } catch {} }
    else if (closing) hangup();
  }, FRAME_MS);
  const play = (pcm8: Uint8Array) => {
    const all = new Uint8Array(rest.length + pcm8.length);
    all.set(rest); all.set(pcm8, rest.length);
    let i = 0;
    for (; all.length - i >= FRAME_BYTES; i += FRAME_BYTES) out.push(all.slice(i, i + FRAME_BYTES));
    rest = all.slice(i);
  };
  const wait = setTimeout(() => { if (state === "uuid") { log("no AudioSocket uuid in time: hung up"); hangup(); } }, deps.uuidWait ?? UUID_WAIT_MS);
  const hangup = () => {
    if (state === "done") return;
    state = "done";
    clearInterval(pump); clearTimeout(wait);
    try { line.write(frame(T.HANGUP)); } catch {}
    try { line.end(); } catch {}
    try { call?.end(); } catch {}
    call = null;
  };
  const begin = () => {
    state = "call";
    clearTimeout(wait);
    log("a call started");
    // the page the call talks to: its audio to the phone; a screen it can't show is said so at once
    const page = {
      send(x: string | Uint8Array) {
        if (state !== "call") return;
        if (typeof x !== "string") return play(down16to8(x));
        let m: any = null;
        try { m = JSON.parse(x); } catch { return; }
        if (m?.type === "interrupt") { out = []; rest = new Uint8Array(0); }
        else if (m?.type === "error" || (m?.type === "ended" && m.why)) log(`the call ended: ${String(m.message ?? m.why).slice(0, 200)}`);
        else if (m?.type === "nav" && typeof m.id === "number") queueMicrotask(() => call?.message(JSON.stringify({ type: "navved", id: m.id, ok: false, why: "this is a phone call: there's no screen to show it on" })));
      },
      // the call ended (the person's yes to hang up, a limit, an error): its last words play out, then hang up
      close() { if (state === "call") closing = true; },
    };
    try { call = deps.start(deps.where(), page); }
    catch (e: any) { log(`the call couldn't start: ${String(e?.message ?? e).slice(0, 200)}`); hangup(); }
  };
  return {
    get on() { return state === "call"; },
    frame(type: number, payload: Uint8Array) {
      if (state === "done") return;
      if (type === T.HANGUP) return hangup();
      if (type === T.ERROR) { log("Asterisk said there was an error"); return hangup(); }
      if (type === T.UUID && state === "uuid") return begin();
      // the caller's voice goes to the call once it is on; keys (DTMF) are the dialplan's, ignored here and never logged
      if (type === T.AUDIO && state === "call" && payload.length && payload.length % 2 === 0) call?.message(Buffer.from(up8to16(payload)));
    },
    /** the line went (Asterisk hung up, the network) */
    gone() { if (state !== "done") { closing = false; out = []; hangup(); } },
  };
}

/** Takes AudioSocket calls on <bind>:<port> from the PBX addresses only. */
export function phoneServer(cfg: { hostname: string; port: number; pbx: string[] }, deps: PhoneDeps) {
  const log = deps.log ?? ((l: string) => console.error(`phone: ${l}`));
  const allowed = new Set(cfg.pbx.map(plain));
  return Bun.listen<{ s: ReturnType<typeof phoneSession> | null; read: ReturnType<typeof framer>; ip: string; pending: Uint8Array[] }>({
    hostname: cfg.hostname, port: cfg.port,
    socket: {
      open(sock) {
        const ip = plain(sock.remoteAddress);
        sock.data = { s: null, read: framer(), ip, pending: [] };
        if (!allowed.has(ip)) {
          log(`refused a connection from ${ip} (not a configured PBX)`);
          sock.end();
          return;
        }
        const write = (b: Uint8Array) => {
          if (sock.data.pending.length) { sock.data.pending.push(b); return; }
          const n = sock.write(b);
          if (n < b.length) sock.data.pending.push(b.slice(Math.max(0, n)));
        };
        sock.data.s = phoneSession({ write, end: () => sock.end() }, { ...deps, log });
      },
      data(sock, chunk) {
        const d = sock.data;
        if (!d?.s) return;
        for (const f of d.read(chunk)) d.s.frame(f.type, f.payload);
      },
      drain(sock) {
        const d = sock.data;
        while (d?.pending.length) {
          const b = d.pending[0], n = sock.write(b);
          if (n < b.length) { d.pending[0] = b.slice(Math.max(0, n)); return; }
          d.pending.shift();
        }
      },
      close(sock) {
        const d = sock.data;
        d?.s?.gone();
      },
      error(sock) { sock.data?.s?.gone(); },
    },
  });
}

/** Follows the setting: the listener up while it says on (and the Voice add-on is), down when not, moved when its
 *  port, address or PBX list change. Checked now and every 15 s. */
export function phoneSwitch(deps: PhoneDeps & { voiceOn: () => boolean; read?: typeof readPhone; ip?: typeof tailnetIP; every?: number }) {
  const log = deps.log ?? ((l: string) => console.error(`phone: ${l}`));
  let now: { key: string; server: { stop(force?: boolean): void } | null } = { key: "", server: null };
  let said = "";
  const once = (l: string) => { if (l !== said) log((said = l)); };
  const check = async () => {
    const c = (deps.read ?? readPhone)();
    const on = c.on && deps.voiceOn();
    const key = on ? JSON.stringify(c) : c.on ? "voice-off" : `off:${(c as any).why ?? ""}`;
    if (key === now.key) return;
    now.server?.stop(true);
    now = { key, server: null };
    if (!c.on) { if ((c as any).why) once(`off: ${(c as any).why}`); return; }
    if (!on) return once("off: the Voice add-on is off");
    const cfg = c as PhoneConfig;
    const hostname = cfg.bind === "tailnet" ? await (deps.ip ?? tailnetIP)() : cfg.bind;
    if (!hostname) { now.key = ""; return once("waiting for this machine's Tailscale address (bind: tailnet)"); }
    try {
      now.server = phoneServer({ hostname, port: cfg.port, pbx: cfg.pbx }, deps);
      once(`taking AudioSocket calls on ${hostname}:${cfg.port} from ${cfg.pbx.join(", ")}`);
    } catch (e: any) { now.key = ""; once(`can't listen on ${hostname}:${cfg.port}: ${e?.message ?? e}`); }
  };
  void check();
  const t = setInterval(() => void check(), deps.every ?? 15_000);
  return { check, stop: () => { clearInterval(t); now.server?.stop(true); now = { key: "", server: null }; } };
}
