// fork: SHEP-50's "@~/" list in the message box, redone on 3.2 (the window's chat it was first written for is gone).
// The walk the old window test made, now through the web box's own steps (web/plugins/chat/paths.tsx) against
// api/paths' listing (service/path-pick.ts) of a made-up home, run by a real sh: "@~/" lists the folder typed so far
// on the agent's machine; Tab, Up/Down, Enter and Escape move through it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPaths, machineOfChat } from "./path-pick.ts";
import { loadDir, matchesFor, pathInto, pathKey, typingPath } from "../web/plugins/chat/paths.tsx";

// The agent's machine's home
const HOME = mkdtempSync(join(tmpdir(), "chat-path-pick-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
for (const d of ["dev/shepherdr/core", "dev/shop", "Documents", "work-a", "work-b", ".config"]) mkdirSync(join(HOME, d), { recursive: true });
for (const f of ["notes.txt", "dev/todo.md", "dev/shepherdr/README.md", "dev/shepherdr/core/mentions.js", "dev/shepherdr/core/path-pick.js"]) writeFileSync(join(HOME, f), "");

const calls: { dir: string; on: string | null }[] = [];
const sh = (script: string, args: string[]) => {
  const p = Bun.spawnSync(["sh", "-c", script, ...args], { env: { HOME, PATH: process.env.PATH ?? "" } });
  return Promise.resolve({ code: p.exitCode ?? 1, stdout: p.stdout.toString() });
};
// api/paths as main.ts answers it: the chat's machine, then its listing
const chats: Record<string, string> = { "p:shop": "vm-b/t3", "p:here": "t1" };
const spaces: Record<string, { machine: string | null }> = { "p:new": { machine: "vm-c" } };
async function api(url: string) {
  const u = new URL(url, "http://x/"), key = u.searchParams.get("chat") ?? "", dir = u.searchParams.get("dir") ?? "~/";
  const on = machineOfChat(key, (k) => chats[k] ?? null, (k) => spaces[k]);
  calls.push({ dir, on });
  const entries = await listPaths(sh, dir);
  return new Response(JSON.stringify({ entries: entries ?? [] }), { status: entries ? 200 : 400 });
}

/** a chat's box: typing lists the folder typed so far; key() is the box's own key handling */
let n = 0;
function box(chat = "p:shop") {
  const b = { chat: `${chat}#${++n}`, real: chat, text: "", sel: 0, moved: false, closed: null as string | null };
  const items = () => (b.closed === b.text ? [] : matchesFor(b.chat, typingPath(b.text)));
  const list = async () => { const t = typingPath(b.text); if (t) await loadDir(b.chat, t.dir, (url) => api(url.replace(encodeURIComponent(b.chat), encodeURIComponent(b.real)))); };
  const type = async (v: string) => { b.text = v; b.sel = 0; b.moved = false; await list(); };
  const key = async (k: string, shift = false) => {
    const r = pathKey(typingPath(b.text), items(), b.sel, b.moved, { key: k, shift, sends: k === "Enter" && !shift });
    if (!r) return false;
    if ("sel" in r) { b.sel = r.sel; b.moved = r.moved; }
    else if ("took" in r) { if (r.took) await type(pathInto(b.text, r.took)); }
    else b.closed = b.text;
    return true;
  };
  return { b, type, key, items };
}

describe('"@~/" in the box (SHEP-50)', () => {
  test("lists home on the agent's machine: folders first, no hidden ones", async () => {
    const c = box();
    await c.type("look at @~/");
    expect(calls.at(-1)).toEqual({ dir: "~/", on: "vm-b" });
    expect(c.items()).toEqual(["dev/", "Documents/", "work-a/", "work-b/", "notes.txt"]);
    await c.type("look at @~/.");
    expect(c.items()).toEqual([".config/"]);
  });

  test("Tab fills in the shared start, then takes the chosen; into a folder it stays open; a file goes in plain", async () => {
    const c = box();
    await c.type("@~/w");
    await c.key("Tab");
    expect(c.b.text).toBe("@~/work-");                      // work-a/ and work-b/ share "work-"
    await c.key("Tab");
    expect(c.b.text).toBe("@~/work-a/");                    // nothing more shared: the chosen one
    await c.type("see @~/de");
    await c.key("Tab");
    expect(c.b.text).toBe("see @~/dev/");
    expect(c.items()).toEqual(["shepherdr/", "shop/", "todo.md"]); // listed at once, still open
    await c.type("see @~/dev/s");
    await c.key("Tab");
    expect(c.b.text).toBe("see @~/dev/sh");                 // shepherdr/ and shop/ share "sh"
    await c.key("Tab");
    expect(c.b.text).toBe("see @~/dev/shepherdr/");
    await c.key("Tab");                                       // core/ first: a folder
    expect(c.b.text).toBe("see @~/dev/shepherdr/core/");
    await c.type("see @~/dev/shepherdr/core/m");
    await c.key("Tab");
    expect(c.b.text).toBe("see ~/dev/shepherdr/core/mentions.js ");
    expect(c.items()).toEqual([]);                            // closed
  });

  test("Down then Tab takes the chosen one, not the shared start; Enter takes it too, and sends nothing", async () => {
    const c = box();
    await c.type("@~/w");
    await c.key("ArrowDown");
    await c.key("Tab");
    expect(c.b.text).toBe("@~/work-b/");
    await c.type("@~/dev/");
    await c.key("ArrowDown"); await c.key("ArrowDown");
    expect(await c.key("Enter")).toBe(true);                  // the box's Enter would send: the list took it
    expect(c.b.text).toBe("~/dev/todo.md ");
    expect(await c.key("Enter")).toBe(false);                 // the list is gone: Enter sends again
  });

  test("Escape closes it for what's typed; typing on opens it again", async () => {
    const c = box();
    await c.type("@~/dev/");
    expect(c.items().length).toBe(3);
    await c.key("Escape");
    expect(c.items()).toEqual([]);
    expect(await c.key("Tab")).toBe(false);                   // closed: Tab is the page's
    await c.type("@~/dev/s");
    expect(c.items()).toEqual(["shepherdr/", "shop/"]);
  });

  test("a folder that isn't there lists nothing; this machine's agent lists here; a new space's chat on its machine", async () => {
    const c = box("p:here");
    await c.type("@~/nope/");
    expect(calls.at(-1)).toEqual({ dir: "~/nope/", on: null });
    expect(c.items()).toEqual([]);
    await box("p:new").type("@~/");
    expect(calls.at(-1)?.on).toBe("vm-c");
  });

  test('"@/" lists from the root', async () => {
    const c = box();
    await c.type(`@${HOME}/dev/t`);
    expect(c.items()).toEqual(["todo.md"]);
    await c.key("Tab");
    expect(c.b.text).toBe(`${HOME}/dev/todo.md `);
  });

  test("api/paths refuses a folder that is neither under home nor the root", async () => {
    expect(await listPaths(sh, "dev/")).toBe(null);
    expect((await api("api/paths?chat=p:shop&dir=dev%2F")).status).toBe(400);
  });
});
