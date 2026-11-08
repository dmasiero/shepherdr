// fork: a new space's Assistant from the web (SHEP-28). pool.fan's Assistant (t7z) stopped on Claude Code's "Do you
// trust this folder?" screen; the person's next message from the web was typed into that screen, its Enter picked
// "No, exit", and the page said it was sent. Now a message to an agent still starting waits for it, and the folder is
// trusted before the Assistant starts. hc, herdr-app and the space's machine are fakes: no window, no core is reached.
import { expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = mkdtempSync(join(tmpdir(), "shep-28-"));
const BIN = join(APP, "bin"), HC_CALLS = join(APP, "hc-calls"), APP_CALLS = join(APP, "herdr-app-calls");
mkdirSync(BIN);
// hc: every call recorded; `run` answers as an Assistant that took its first message
writeFileSync(join(BIN, "hc"), `#!/bin/sh\necho "$*" >> "${HC_CALLS}"\ncase "$1" in run) echo '{"address":"t90","first_message":{"sent":true}}';; *) echo '{}';; esac\n`, { mode: 0o755 });
// herdr-app: a window that closes a space when asked; anything else, no window
writeFileSync(join(BIN, "herdr-app"), `#!/bin/sh\necho "$*" >> "${APP_CALLS}"\n[ "$2" = space.close ] && { echo '{}'; exit 0; }\necho "herdr-app: no window is running" >&2\nexit 1\n`, { mode: 0o755 });

// One Bun process runs every service test: actions.ts keeps the app home it was first loaded with (saved-spaces.test.ts
// sorts first), so the space log is read where it writes it (spaceLogFile).
let act: typeof import("./actions.ts").act, stillStarting: typeof import("./actions.ts").stillStarting, spaceLogFile: typeof import("./actions.ts").spaceLogFile;
let newSpace: typeof import("./spaces.ts").newSpace;
const was = process.env.HERDR_APP_HOME;
beforeAll(async () => {
  process.env.HERDR_APP_HOME = APP;   // no mods/spaces-chat here: a web-only install (spaces.ts withWindow)
  process.env.SHEPHERDR_HERDR_APP = join(BIN, "herdr-app");
  process.env.SHEPHERDR_HC = join(BIN, "hc");
  ({ act, stillStarting, spaceLogFile } = await import("./actions.ts"));
  ({ newSpace } = await import("./spaces.ts"));
});
afterAll(() => {
  delete process.env.SHEPHERDR_HERDR_APP; delete process.env.SHEPHERDR_HC;
  if (was === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = was;
});

// t7z as it was: Claude Code (Nix's wrapper) on its start screen, live, no status yet, no turn
const onStartScreen = (address: string): any => ({ address, state: "live", turn: 0, status: null, created_ms: Date.now(), labels: {}, foreground: { name: ".claude-wrapped", argv: ["claude"] } });
function world(terms: any[]) {
  const sent: [string, string][] = [], execs: { argv: string[]; on?: string }[] = [];
  const hub = {
    terminals: new Map<string, any>(terms.map((t) => [t.address, t])),
    on() { return () => {}; },
    async send(t: string, text: string) { sent.push([t, text]); return { code: 0, stdout: JSON.stringify({ started: true }), stderr: "" }; },
    async call(method: string, p: any = {}): Promise<any> {
      if (method === "machine.exec") {
        execs.push({ argv: p.argv, on: p.on });
        const out = p.argv[0] === "python3" ? "set\n" : "";
        return { code: 0, stdout: Buffer.from(out).toString("base64"), stderr: "" };
      }
      throw new Error(`no ${method}`);
    },
  };
  return { hub, sent, execs };
}
const compat = (addrOf: (k: string) => string | null, spaces: any[] = []) => {
  const shared: Record<string, any> = {};
  return {
    addrOf, tasksFor: () => [], noteSend: () => {}, reader: () => null,
    spaceOf: (id: string) => spaces.find((s) => s.id === id) ?? null,
    shared: { value: (k: string) => shared[k], set: async (k: string, v: unknown) => { shared[k] = v; } },
  } as any;
};
const calls = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);

test("a message to an Assistant on its trust screen waits: nothing is typed there, and it goes once the agent has started", async () => {
  const t = onStartScreen("t7z"), w = world([t]), c = compat((k) => (k === "p:spP" ? "t7z" : null));
  expect(stillStarting("t7z", t)).toBe(true);
  const r: any = await act(w.hub as any, { type: "send", chat: "p:spP", text: "plan the first steps", cid: "c1" }, c);
  expect(r).toEqual({ ok: true, waiting: true, waitsFor: "start" });
  await Bun.sleep(1500);
  expect(w.sent).toEqual([]);                                            // never pasted into the screen, no Enter
  t.status = { state: "idle", app: "claude-code" };                       // the person answered the screen: it started
  await Bun.sleep(1500);
  expect(w.sent).toEqual([["t7z", "plan the first steps"]]);
});

test("an agent that has started takes a message at once, as before", async () => {
  const t = { ...onStartScreen("t5"), turn: 3, status: { state: "idle", app: "claude-code" } }, w = world([t]), c = compat(() => "t5");
  expect(stillStarting("t5", t)).toBe(false);
  const r: any = await act(w.hub as any, { type: "send", chat: "p:spQ", text: "hi" }, c);
  expect(r.ok).toBe(true);
  expect(r.waiting).toBeUndefined();
  expect(w.sent).toEqual([["t5", "hi"]]);
});

test("one that never reports a session isn't held for good: past half an hour it's typed as before", () => {
  expect(stillStarting("t6", { ...onStartScreen("t6"), created_ms: Date.now() - 31 * 60_000 })).toBe(false);
  expect(stillStarting("t7", { ...onStartScreen("t7"), foreground: { name: "fish" } })).toBe(false);   // a shell
});

test("the web's first message starts the Assistant only after Claude Code trusts the space's folder, on its machine", async () => {
  const w = world([]);
  const r: any = await act(w.hub as any, { type: "send", chat: "p:spP2", text: "hello" }, compat(() => null, [{ id: "spP2", folder: "/srv/dev/pool.fan", machine: null }]));
  expect(r).toEqual({ ok: true, started: true });
  expect(w.execs[0].argv.slice(0, 2)).toEqual(["python3", "-c"]);
  expect(w.execs[0].argv[3]).toBe("/srv/dev/pool.fan");
  expect(calls(HC_CALLS).some((l) => l.startsWith("run ") && l.includes("--cwd /srv/dev/pool.fan"))).toBe(true);
});

test("New space from the web trusts the folder it makes the space in", async () => {
  const w = world([]), store = compat(() => null).shared;
  await store.set("coordinator.auto", false);   // no Assistant here: the trust is New space's own
  const place = await newSpace(w.hub as any, { machine: null, path: "/srv/pool.fan", store });
  expect(place).toMatch(/^sp[0-9a-f]{32}$/);
  const trust = w.execs.find((e) => e.argv[0] === "python3");
  expect(trust?.argv[3]).toBe("/srv/pool.fan");
  expect(trust?.on).toBeUndefined();
});

test("Close space from the web with the window open is in the space log, by the web", async () => {
  const w = world([]), c = compat(() => null, [{ id: "spPool", folder: "/srv/dev/pool.fan", machine: null, name: "pool.fan" }]);
  expect(await act(w.hub as any, { type: "space-remove", place: "spPool" }, c)).toEqual({ ok: true });
  expect(calls(APP_CALLS)).toContain("do space.close --id spPool --confirmed true");
  const log = readFileSync(spaceLogFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.at(-1)).toMatchObject({ space: "spPool", name: "pool.fan", action: "close", machine: null, by: "web: Close space (service/actions.ts, the window closed it)" });
});
