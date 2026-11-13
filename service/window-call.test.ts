// SHEP-57: the Herdr window's voice call is the web app's call. The window's helper (mods/chat/voice.ts, run for real
// as the chat mod runs it) opens /api/voice as a window client on a stand-in for this machine's service that holds the
// real call (voice.ts voiceCall), with a fake voice agent behind it. The helper only carries sound (fake pw-record and
// pw-play) and links the call to the chat's folder: state, opens (nav/ and navved/), what the window shows, hang up.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { voiceAsked, voiceCall } from "./voice.ts";
import type { VoiceIO } from "./voice-tools.ts";
import type { HearIO } from "./voice-hear.ts";

const HELPER = join(import.meta.dir, "..", "mods", "chat", "voice.ts");
const now = Date.now();
const snap: any = {
  host: "nextgate", name: "Shepherdr", user: "You",
  machines: [{ id: "m:nextgate", machine: "nextgate", name: "This computer", status: "idle", here: true }],
  places: [{ id: "sp1", name: "shepherdr", home: false, machine: "nextgate", chat: "p:sp1" }],
  tasks: [], needs: [], automations: {}, settings: [], asks: {},
  artifacts: [{ id: "hulk", title: "Hulk mini game · Proof", place: "sp1", v: 1, at: now, when: "1m", by: "x" }],
};
const io: VoiceIO = { snap: () => snap, chat: async () => null, send: async () => {}, action: async () => ({ ok: true }) };
const hear: HearIO = { snap: () => snap, view: () => null, follow: () => ({ stop: () => {} }) };
const until = async (f: () => boolean, n = 150) => { for (let i = 0; i < n && !f(); i++) await Bun.sleep(40); return f(); };

// the fake voice agent (ElevenLabs): what the call sent it
let agent: any = null;
const toAgent: any[] = [];
const agentServer = Bun.serve({
  port: 0,
  fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
  websocket: {
    open(ws) { agent = ws; ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: { agent_output_audio_format: "pcm_16000" } })); },
    message(_ws, m) { toAgent.push(JSON.parse(String(m))); },
    close() { agent = null; },
  },
});

// this machine's service, as far as a call goes: its health, and /api/voice holding the real call
const TOKEN = "local-token-for-test";
const asked: any[] = [];
const fromHelper: any[] = [];
const service = Bun.serve({
  port: 0,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/api/health") return Response.json({ id: "svc-1" });
    if (url.pathname !== "/api/voice") return new Response("no", { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no token", { status: 401 });
    const voice = voiceAsked(url.searchParams, true, null, (a) => (a === "t89" ? "p:sp1" : null));
    asked.push(voice);
    return srv.upgrade(req, { data: { voice } as any }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    open(ws) {
      const d: any = ws.data;
      d.page = { send: (x: any) => { ws.send(x); }, close: () => ws.close() };
      d.call = voiceCall({} as any, { io, hear, where: { client: d.voice.window ? "window" : "web", call: d.voice.key, machine: "nextgate", ...d.voice.at },
        dial: async () => `ws://127.0.0.1:${agentServer.port}/`, navWait: 4000, log: () => {} }, d.page);
    },
    message(ws, m) { const d: any = ws.data; fromHelper.push(typeof m === "string" ? JSON.parse(m) : { bytes: (m as any).byteLength }); d.call.message(m); },
    close(ws) { const d: any = ws.data; d.call.detach(d.page); },
  },
});
afterAll(() => { service.stop(true); agentServer.stop(true); });

/** A scratch machine: the service's folder (service.json, token), fake pw-record (a steady tone) and pw-play (keeps
 *  what it plays), and the chat's call folder, as runCall makes it. */
function machine(serviceUp = true) {
  const root = mkdtempSync(join(tmpdir(), "wcall-"));
  const data = join(root, "service"), bin = join(root, "bin"), call = join(root, "call");
  mkdirSync(data); mkdirSync(bin); mkdirSync(join(call, "in"), { recursive: true });
  writeFileSync(join(data, "service.json"), JSON.stringify({ port: serviceUp ? service.port : 1, id: "svc-1" }));
  writeFileSync(join(data, "token"), TOKEN);
  writeFileSync(join(call, "alive"), "");
  writeFileSync(join(call, "where.json"), JSON.stringify({ place: "sp1", task: null, tab: null }));
  // (nextgate's /usr/bin shows a tool only to a PATH that has it: the ones the fakes need, linked in)
  for (const t of ["sh", "head", "sleep", "cat", "printf"]) { const at = Bun.which(t); if (at) symlinkSync(at, join(bin, t)); }
  writeFileSync(join(bin, "pw-record"), "#!/bin/sh\nwhile :; do head -c 3200 /dev/urandom; sleep 0.1; done\n");
  writeFileSync(join(bin, "pw-play"), `#!/bin/sh\ncat >> "${join(root, "played")}"\n`);
  chmodSync(join(bin, "pw-record"), 0o755); chmodSync(join(bin, "pw-play"), 0o755);
  const p = Bun.spawn([process.execPath, HELPER, call, "t89", "Claude Code"], {
    env: { PATH: `${bin}:${dirname(process.execPath)}`, HOME: root, HERDR_APP_HOME: root, SHEPHERDR_DATA: data },
    stdout: "ignore", stderr: "pipe",
  });
  const state = () => { try { return JSON.parse(readFileSync(join(call, "state.json"), "utf8")); } catch { return null; } };
  return { root, call, p, state, played: () => (existsSync(join(root, "played")) ? readFileSync(join(root, "played")).length : 0) };
}

test("the window's call runs on the service's call: sound both ways, an open shown by the chat, hang up", async () => {
  const m = machine();
  // connected as the window's client, for the chat of t89, showing the space
  expect(await until(() => asked.length > 0 && !!agent)).toBe(true);
  expect(asked.at(-1)).toMatchObject({ window: true, key: "p:sp1", at: { place: "sp1" } });
  expect(await until(() => m.state()?.phase === "listening")).toBe(true);
  // the voice agent's opening: the call is in the Herdr window, showing the space
  expect(await until(() => toAgent.some((x) => x.type === "conversation_initiation_client_data"))).toBe(true);
  const prompt = toAgent.find((x) => x.type === "conversation_initiation_client_data").conversation_config_override.agent.prompt.prompt;
  expect(prompt).toContain("the Herdr window on nextgate");
  expect(prompt).toContain("shepherdr");
  // the window's microphone reaches the voice agent
  expect(await until(() => toAgent.some((x) => typeof x.user_audio_chunk === "string"))).toBe(true);
  // the voice agent's voice plays in the window
  agent.send(JSON.stringify({ type: "audio", audio_event: { audio_base_64: Buffer.alloc(3200, 7).toString("base64") } }));
  expect(await until(() => m.played() >= 3200)).toBe(true);
  // what it said, for the call card
  agent.send(JSON.stringify({ type: "agent_response", agent_response_event: { agent_response: "Hi, go ahead." } }));
  expect(await until(() => m.state()?.said === "Hi, go ahead.")).toBe(true);

  // an open: the window's chat shows it (nav/ -> navved/), and only then the agent hears it's on screen
  const n = toAgent.length;
  agent.send(JSON.stringify({ type: "client_tool_call", client_tool_call: { tool_name: "open", tool_call_id: "o1", parameters: { what: "artifact", id: "hulk" } } }));
  const navDir = join(m.call, "nav");
  expect(await until(() => existsSync(navDir) && readdirSync(navDir).some((f) => f.endsWith(".json")))).toBe(true);
  const name = readdirSync(navDir).find((f) => f.endsWith(".json"))!;
  expect(JSON.parse(readFileSync(join(navDir, name), "utf8"))).toMatchObject({ kind: "artifact", artifact: "hulk" });
  mkdirSync(join(m.call, "navved"), { recursive: true });
  writeFileSync(join(m.call, "navved", name), JSON.stringify({ ok: true }));
  expect(await until(() => toAgent.slice(n).some((x) => x.type === "client_tool_result" && x.tool_call_id === "o1"))).toBe(true);
  const r = toAgent.slice(n).find((x) => x.tool_call_id === "o1");
  expect(r.is_error).toBe(false);
  expect(JSON.parse(r.result)).toMatchObject({ ok: true });
  expect(fromHelper.some((x) => x.type === "navved" && x.ok === true)).toBe(true);

  // the window moved: told to the call as the page's "where"
  writeFileSync(join(m.call, "where.json"), JSON.stringify({ place: "sp1", task: "SHEP-57", tab: "chat" }));
  expect(await until(() => fromHelper.some((x) => x.type === "where" && x.task === "SHEP-57"))).toBe(true);

  // End in the window: the service's call ends, the helper goes
  writeFileSync(join(m.call, "in", "1.json"), JSON.stringify({ type: "hangup" }));
  expect(await until(() => fromHelper.some((x) => x.type === "end"))).toBe(true);
  expect(await until(() => agent === null)).toBe(true);
  await m.p.exited;
  expect(m.state()).toMatchObject({ phase: "ended", error: null });
  rmSync(m.root, { recursive: true, force: true });
}, 30_000);

test("no service on this machine: no call, and the window says so", async () => {
  const m = machine(false);
  await m.p.exited;
  expect(m.state()).toMatchObject({ phase: "ended" });
  expect(m.state().error).toContain("Shepherdr's service isn't running on this machine");
  rmSync(m.root, { recursive: true, force: true });
}, 15_000);

test("the window's client is this machine's only; a page can't pass for it", () => {
  const q = new URLSearchParams({ client: "window", addr: "t89", where: JSON.stringify({ place: "sp1", tab: "chat" }) });
  expect(voiceAsked(q, true, null, () => "p:sp1")).toMatchObject({ window: true, key: "p:sp1", at: { place: "sp1", tab: "chat" } });
  expect(voiceAsked(q, false, "p:web", () => "p:sp1")).toMatchObject({ window: false, key: "p:web" });
});
