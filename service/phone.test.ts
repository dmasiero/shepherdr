// SHEP-44: a phone call through Asterisk's AudioSocket, end to end but for Asterisk and ElevenLabs: a fake AudioSocket
// client (the PBX) dials the real listener (phone.ts), which runs the real call (voice.ts voiceCall) against a fake
// voice agent's socket, as voice-call.test.ts does.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { voiceCall } from "./voice.ts";
import { voiceTool, type VoiceIO, type Where } from "./voice-tools.ts";
import type { HearIO } from "./voice-hear.ts";
import { T, frame, framer, uuidOf, up8to16, down16to8, phoneServer, phoneSwitch, readPhone, vaultPin, plain, PIN_NAME, type PhoneDeps } from "./phone.ts";

const snap: any = {
  host: "box", name: "Shepherdr", user: "You", machines: [{ id: "m:box", machine: "box", name: "This computer", status: "idle", here: true }],
  places: [{ id: "h1", name: "Home", home: true, machine: "box", chat: "p:h1" }],
  tasks: [], needs: [], automations: {}, settings: [], asks: {}, artifacts: [],
};
const io: VoiceIO = { snap: () => snap, chat: async () => null, send: async () => {}, action: async () => ({ ok: true }) };
const hear: HearIO = { snap: () => snap, view: () => null, follow: () => ({ stop: () => {} }) };

// the fake voice agent: what it heard, and its socket to talk back on
let agent: any = null, dialled = 0, agentClosed = 0;
const heard: any[] = [];
const eleven = Bun.serve({
  port: 0,
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: {
    open(ws) { agent = ws; dialled++; ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { agent_output_audio_format: "pcm_16000" } })); },
    message(_ws, m) { heard.push(JSON.parse(String(m))); },
    close() { agentClosed++; },
  },
});

const UUID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const uuidBytes = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const logs: string[] = [];
let pin: string | null = "4321";
const deps: PhoneDeps = {
  pin: async () => pin,
  where: () => ({ client: "phone", machine: "box", call: "p:h1" }),
  start: (w, page) => voiceCall({} as any, { io, hear, where: w, who: "phone", dial: async () => `ws://127.0.0.1:${eleven.port}/` }, page),
  log: (l) => logs.push(l),
  pinWait: 3000,
};
const pbx = phoneServer({ hostname: "127.0.0.1", port: 0, pbx: ["127.0.0.1"] }, deps);
afterAll(() => { pbx.stop(true); eleven.stop(true); });

/** The PBX's side: AudioSocket frames over TCP, and what came back. */
function dial(port = pbx.port) {
  const got: { type: number; payload: Uint8Array }[] = [];
  const read = framer();
  let closed = false;
  const s: Socket = connect(port, "127.0.0.1");
  s.on("data", (b: Buffer) => { for (const f of read(new Uint8Array(b))) got.push(f); });
  s.on("close", () => { closed = true; });
  s.on("error", () => {});
  return {
    got, get closed() { return closed; },
    audio: () => got.filter((f) => f.type === T.AUDIO),
    send: (type: number, payload?: Uint8Array) => s.write(frame(type, payload)),
    digits: (d: string) => { for (const c of d) s.write(frame(T.DTMF, new Uint8Array([c.charCodeAt(0)]))); },
    raw: (b: Uint8Array) => s.write(b),
    end: () => s.end(),
  };
}
const until = async (f: () => boolean, n = 150) => { for (let i = 0; i < n && !f(); i++) await Bun.sleep(20); };
const sine = (hz: number, rate: number, n: number, level = 8000) => new Uint8Array(new Int16Array(n).map((_, i) => Math.round(level * Math.sin((2 * Math.PI * hz * i) / rate))).buffer);
const rms = (b: Uint8Array) => { const s = new Int16Array(b.buffer, b.byteOffset, b.length >> 1); return Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length); };

test("framing: a frame is type, 2-byte big-endian length, payload; split across reads it still comes whole", () => {
  expect([...frame(T.AUDIO, new Uint8Array([1, 2, 3]))]).toEqual([0x10, 0, 3, 1, 2, 3]);
  expect([...frame(T.HANGUP)]).toEqual([0, 0, 0]);
  const big = frame(T.AUDIO, new Uint8Array(320).fill(7));
  expect([big[1], big[2]]).toEqual([1, 64]);
  const read = framer();
  const two = new Uint8Array([...frame(T.UUID, uuidBytes(UUID)), ...big]);
  expect(read(two.slice(0, 2))).toEqual([]);
  const a = read(two.slice(2, 25));
  expect(a.map((f) => f.type)).toEqual([T.UUID]);
  expect(uuidOf(a[0].payload)).toBe(UUID);
  const b = read(two.slice(25));
  expect(b).toHaveLength(1);
  expect(b[0].payload.length).toBe(320);
});

test("resampling: the phone's 8 kHz doubles to 16 kHz and back, a tone keeps its level", () => {
  const up = up8to16(new Uint8Array(new Int16Array([0, 100, -100, 50]).buffer));
  expect([...new Int16Array(up.buffer, up.byteOffset, up.length >> 1)]).toEqual([0, 50, 100, 0, -100, -25, 50, 50]);
  const down = down16to8(new Uint8Array(new Int16Array([10, 20, -30, -50]).buffer));
  expect([...new Int16Array(down.buffer, down.byteOffset, down.length >> 1)]).toEqual([15, -40]);
  // 20 ms of a 400 Hz voice-band tone: 320 bytes at 8 kHz, 640 at 16 kHz, and back to 320
  const tone8 = sine(400, 8000, 160);
  const t16 = up8to16(tone8);
  expect(t16.length).toBe(640);
  expect(Math.abs(rms(t16) - rms(tone8)) / rms(tone8)).toBeLessThan(0.05);
  const back = down16to8(sine(400, 16000, 320));
  expect(back.length).toBe(320);
  expect(Math.abs(rms(back) - rms(tone8)) / rms(tone8)).toBeLessThan(0.05);
});

test("the setting: off with no file, off without a PBX address; bind defaults to the tailnet, never 0.0.0.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "phone-"));
  const f = join(dir, "phone.json");
  expect(readPhone(f)).toEqual({ on: false });
  writeFileSync(f, JSON.stringify({ on: true }));
  expect(readPhone(f).on).toBe(false);
  writeFileSync(f, JSON.stringify({ on: true, pbx: "100.64.0.9" }));
  expect(readPhone(f)).toEqual({ on: true, port: 9092, bind: "tailnet", pbx: ["100.64.0.9"] });
  writeFileSync(f, JSON.stringify({ on: false, pbx: ["100.64.0.9"] }));
  expect(readPhone(f).on).toBe(false);
  expect(plain("::ffff:100.64.0.9")).toBe("100.64.0.9");
  // the PIN: Everywhere's, digits or a uuid; anything else is no PIN
  const v = (value: string, scope = "everywhere") => () => JSON.stringify({ secrets: [{ name: PIN_NAME, scope, value }] });
  expect(vaultPin("x", v("4321"))).toBe("4321");
  expect(vaultPin("x", v(UUID))).toBe(UUID);
  expect(vaultPin("x", v("12"))).toBeNull();
  expect(vaultPin("x", v("4321", "space"))).toBeNull();
  expect(vaultPin("x", () => { throw new Error("none"); })).toBeNull();
});

test("an address that isn't the PBX is refused at once: no PIN, no call", async () => {
  const other = phoneServer({ hostname: "127.0.0.1", port: 0, pbx: ["100.64.0.9"] }, deps);
  const before = dialled;
  const c = dial(other.port);
  c.send(T.UUID, uuidBytes(UUID));
  await until(() => c.closed);
  expect(c.closed).toBe(true);
  expect(c.got).toEqual([]);
  expect(dialled).toBe(before);
  expect(logs.at(-1)).toBe("refused a connection from 127.0.0.1 (not a configured PBX)");
  other.stop(true);
});

test("a wrong PIN three times: a low tone, then hung up; the voice agent is never dialled", async () => {
  const before = dialled;
  const c = dial();
  c.send(T.UUID, uuidBytes(UUID));
  await until(() => c.audio().length > 0);
  // the "type your PIN" tone came; meanwhile the caller's voice goes nowhere
  c.send(T.AUDIO, sine(400, 8000, 160));
  c.digits("1111"); await Bun.sleep(100);
  c.digits("2222"); await Bun.sleep(100);
  c.digits("99#");
  await until(() => c.closed, 300);
  expect(c.got.at(-1)!.type).toBe(T.HANGUP);
  expect(dialled).toBe(before);
  expect(logs).toContain("wrong PIN too often: hung up");
  // no PIN digits or audio in the log
  expect(logs.join("\n")).not.toMatch(/1111|2222|4321/);
});

test("the right PIN on the keys: the call starts; the caller's voice reaches the agent at 16 kHz, its voice comes back at 8 kHz in 20 ms frames; the PBX hangs up, the call ends", async () => {
  const c = dial();
  c.send(T.UUID, uuidBytes(UUID));
  await until(() => c.audio().length > 0);
  agent = null;
  c.digits("4321");
  await until(() => !!agent);
  expect(agent).not.toBeNull();
  // the opening says it's a phone call, with no screen, with Shepherdr
  await until(() => heard.some((m) => m.type === "conversation_initiation_client_data"));
  const open = heard.findLast((m) => m.type === "conversation_initiation_client_data");
  expect(open.conversation_config_override.agent.prompt.prompt).toContain("The call runs in a phone call. It is with Shepherdr");
  expect(open.conversation_config_override.agent.prompt.prompt).toContain("no screen");
  await Bun.sleep(100);
  const n = heard.length;
  c.send(T.AUDIO, sine(400, 8000, 160));
  await until(() => heard.slice(n).some((m) => m.user_audio_chunk));
  const chunk = Buffer.from(heard.slice(n).find((m) => m.user_audio_chunk).user_audio_chunk, "base64");
  expect(chunk.length).toBe(640);
  // 100 ms of the agent's voice at 16 kHz: five 20 ms frames at 8 kHz
  const was = c.audio().length;
  agent.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: Buffer.from(sine(300, 16000, 1600)).toString("base64") } }));
  await until(() => c.audio().length >= was + 5);
  const said = c.audio().slice(was);
  expect(said).toHaveLength(5);
  expect(said.every((f) => f.payload.length === 320)).toBe(true);
  const closed = agentClosed;
  c.send(T.HANGUP);
  await until(() => agentClosed > closed);
  expect(agentClosed).toBe(closed + 1);
  await until(() => c.closed);
  expect(c.closed).toBe(true);
});

test("a PIN that is the dialplan's uuid: the call starts with no keys; the agent ends it, the PBX is hung up", async () => {
  pin = UUID;
  agent = null;
  const c = dial();
  c.send(T.UUID, uuidBytes(UUID));
  await until(() => !!agent);
  expect(agent).not.toBeNull();
  await Bun.sleep(100);
  agent.close(1000, "Conversation has exceeded maximum duration");
  await until(() => c.closed, 300);
  expect(c.got.at(-1)!.type).toBe(T.HANGUP);
  // another uuid: refused
  const before = dialled;
  const d = dial();
  d.send(T.UUID, uuidBytes("00000000-0000-0000-0000-000000000000"));
  await until(() => d.closed, 300);
  expect(d.got.at(-1)!.type).toBe(T.HANGUP);
  expect(dialled).toBe(before);
  pin = "4321";
});

test("no PIN kept: every call is refused", async () => {
  pin = null;
  const before = dialled;
  const c = dial();
  c.send(T.UUID, uuidBytes(UUID));
  await until(() => c.closed, 300);
  expect(dialled).toBe(before);
  expect(logs.some((l) => l.includes(`no ${PIN_NAME} kept`))).toBe(true);
  pin = "4321";
});

test("a phone call's tools: nothing to open or show, said so", async () => {
  const w: Where = { client: "phone", machine: "box", call: "p:h1" };
  for (const name of ["open", "screen", "call_view"]) {
    const a = await voiceTool(name, { what: "space", id: "home", do: "scroll", view: "full" }, w, io);
    expect(a.error).toBe(true);
    expect(a.result).toContain("phone call");
    expect(a.nav).toBeUndefined();
  }
});

test("the switch: up while on, down when off or when the Voice add-on is", async () => {
  let cfg: any = { on: true, port: 0, bind: "127.0.0.1", pbx: ["127.0.0.1"] }, voice = true;
  const said: string[] = [];
  const sw = phoneSwitch({ ...deps, log: (l) => said.push(l), voiceOn: () => voice, read: () => cfg, every: 1e9 });
  await Bun.sleep(50);
  expect(said.at(-1)).toContain("taking AudioSocket calls on 127.0.0.1:0");
  voice = false; await sw.check();
  expect(said.at(-1)).toBe("off: the Voice add-on is off");
  voice = true; cfg = { on: true, port: 0, bind: "tailnet", pbx: ["127.0.0.1"] };
  const sw2 = phoneSwitch({ ...deps, log: (l) => said.push(l), voiceOn: () => true, read: () => cfg, ip: async () => null, every: 1e9 });
  await Bun.sleep(50);
  expect(said.at(-1)).toBe("waiting for this machine's Tailscale address (bind: tailnet)");
  sw.stop(); sw2.stop();
});
