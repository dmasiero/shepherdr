// Window images were empty grey boxes (SHEP-39): the chat's thumbnails and artifact cards get each image's size from
// attach.viewable(), which asks ImageMagick, else ffprobe. ffprobe 8 refuses the space separator it was given
// (csv=s=' '), so on a machine without ImageMagick no image got a size and none was drawn. This runs the real script
// with the real ffprobe on a real PNG, with a magick that fails first on PATH.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fakeHerdr } from "./fake-herdr";

const root = mkdtempSync(join(tmpdir(), "attach-view-"));
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "magick"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "magick"), 0o755);
const PATH = `${bin}:${process.env.PATH}`;
const hasProbe = Bun.spawnSync(["sh", "-c", "command -v ffprobe"], { env: { ...process.env, PATH } }).exitCode === 0;

// Another machine (SHEP-47): exec { on: "nextgate" } runs with its paths under <root>/nextgate (so "/nextgate/…" is
// nowhere here) and its home there; "gone" can't be reached. Every call there is counted.
const there = join(root, "nextgate");
mkdirSync(join(there, "home"), { recursive: true });
const remoteCalls: string[][] = [];
const tooBig = 8 * 1024 * 1024;   // exec's own output limit
mock.module("herdr", () => fakeHerdr({
  exec: async (cmd: string, args: string[], opts?: { on?: string | null }) => {
    if (opts?.on === "gone") throw new Error("unreachable");
    const argv = opts?.on ? [cmd, ...args].map((a) => a.startsWith("/nextgate/") ? there + a.slice("/nextgate".length) : a) : [cmd, ...args];
    if (opts?.on) remoteCalls.push(argv);
    const p = Bun.spawnSync(argv, { env: { ...process.env, PATH, ...(opts?.on ? { HOME: join(there, "home") } : {}) } });
    const stdout = opts?.on ? p.stdout.toString().replaceAll(there, "/nextgate") : p.stdout.toString();
    if (opts?.on && stdout.length > tooBig) throw new Error("output too big");
    return { code: p.exitCode, stdout, stderr: p.stderr.toString() };
  },
  appHome: () => root, window: () => ({ platform: "linux" }), settings: () => ({}),
}));
const attach = await import("../mods/chat/attach.js");

// A w×h grey PNG, made here (no image tools on the dev VM).
function png(w: number, h: number) {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(t));
    return Buffer.concat([len, t, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("window chat images get their size without ImageMagick (SHEP-39)", () => {
  test("ffprobe's size is asked with a separator every version takes", () => {
    expect(attach.VIEW).not.toContain("s=' '");
    expect(attach.VIEW).toContain("-of csv=p=0 ");
  });

  test.skipIf(!hasProbe)("a pasted PNG is linked for image() with its size", async () => {
    const file = join(root, "pasted-shot.png");
    writeFileSync(file, png(37, 11));
    const out = (await attach.viewable([file, join(root, "gone.png")])) as Record<string, { rel: string; w: number; h: number }>;
    expect(Object.keys(out)).toEqual([file]);
    expect(out[file].w).toBe(37);
    expect(out[file].h).toBe(11);
    expect(out[file].rel).toMatch(/^data\/chat-attach\/view\/\d+-pasted-shot\.png$/);
    expect(existsSync(join(root, out[file].rel))).toBe(true);
  });

  test.skipIf(!hasProbe)("a file that isn't an image gets no size", async () => {
    const file = join(root, "notes.png");
    writeFileSync(file, "not a picture");
    expect(await attach.viewable([file])).toEqual({});
  });
});

describe("window chat images from an agent on another machine (SHEP-47)", () => {
  const put = (rel: string, w: number, h: number) => {
    const at = join(there, rel);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, png(w, h));
    return at;
  };

  test("the old way finds nothing: the path isn't on this machine", async () => {
    put("files/t89/shot-a.png", 20, 10);
    expect(await attach.viewable(["/nextgate/files/t89/shot-a.png"])).toEqual({});
  });

  test.skipIf(!hasProbe)("a remote image is copied here once, in pieces, and shown with its size", async () => {
    const src = put("files/t89/shot-b.png", 156, 25);
    const p = "/nextgate/files/t89/shot-b.png";
    remoteCalls.length = 0;
    const { views, failed } = (await attach.remoteViewable([p, "/nextgate/files/none.png"], "nextgate", { piece: 100 })) as any;
    expect(failed).toEqual([]);
    expect(Object.keys(views)).toEqual([p]);
    expect([views[p].w, views[p].h]).toEqual([156, 25]);
    expect(views[p].rel).toMatch(/^data\/chat-attach\/remote\/nextgate-[0-9a-f]{8}-shot-b\.png$/);
    expect(readFileSync(join(root, views[p].rel)).equals(readFileSync(src))).toBe(true);
    const pieces = remoteCalls.filter((a) => a[3] === "piece").length;
    expect(pieces).toBe(Math.ceil(readFileSync(src).length / 100));
    expect(pieces).toBeGreaterThan(1);
    // Asked again (a new chat view, the window restarted): the copy here does, nothing is asked of the machine.
    remoteCalls.length = 0;
    const again = (await attach.remoteViewable([p], "nextgate")) as any;
    expect([again.views[p].w, again.views[p].h]).toEqual([156, 25]);
    expect(remoteCalls).toEqual([]);
  });

  test.skipIf(!hasProbe)("a picture pasted here first is shown from its original, not fetched", async () => {
    mkdirSync(join(root, "data/chat-attach"), { recursive: true });
    writeFileSync(join(root, "data/chat-attach/pasted-20261112T150701.png"), png(30, 40));
    remoteCalls.length = 0;
    const p = "/srv/herdr-core/default/files/t89/pasted-20261112T150701.png";
    const { views } = (await attach.remoteViewable([p], "nextgate")) as any;
    expect([views[p].w, views[p].h]).toEqual([30, 40]);
    expect(remoteCalls).toEqual([]);
  });

  test.skipIf(!hasProbe)("a ~/ path is read in that machine's home", async () => {
    put("home/pics/shot-c.png", 12, 34);
    const { views } = (await attach.remoteViewable(["~/pics/shot-c.png"], "nextgate")) as any;
    expect([views["~/pics/shot-c.png"].w, views["~/pics/shot-c.png"].h]).toEqual([12, 34]);
  });

  test.skipIf(!hasProbe)("too big is left a quiet box, and nothing is fetched", async () => {
    put("files/big.png", 64, 64);
    remoteCalls.length = 0;
    const { views, failed } = (await attach.remoteViewable(["/nextgate/files/big.png"], "nextgate", { max: 10 })) as any;
    expect(views).toEqual({});
    expect(failed).toEqual([]);
    expect(remoteCalls.filter((a) => a[3] === "piece")).toEqual([]);
  });

  test("an unreachable machine: the paths come back to ask again", async () => {
    const { views, failed } = (await attach.remoteViewable(["/x/a.png", "/x/b.png"], "gone")) as any;
    expect(views).toEqual({});
    expect(failed).toEqual(["/x/a.png", "/x/b.png"]);
  });

  test("each piece stays under exec's 8 MiB output in base64", () => {
    expect(Math.ceil(attach.PIECE / 3) * 4 * (1 + 1 / 76)).toBeLessThan(tooBig);
  });
});

// The chat's needViews() as written in mods/chat/main.js, run with a stand-in attach: messages of a chat on another
// machine go to remoteViewable() there, the box's own files stay here, each is asked once, an unreachable one again later.
describe("the window chat asks for its images where they are (SHEP-47)", () => {
  const src = readFileSync(join(import.meta.dir, "../mods/chat/main.js"), "utf8");
  const m = /\n  needViews\(paths, cx, on = null\) \{\n[\s\S]*?\n  \}\n/.exec(src);
  const calls: any[] = [];
  const fakeAttach = {
    viewable: async (list: string[]) => { calls.push(["here", list]); return Object.fromEntries(list.map((p) => [p, { rel: "r", w: 1, h: 1 }])); },
    remoteViewable: async (list: string[], on: string) => {
      calls.push([on, list]);
      return { views: Object.fromEntries(list.filter((p) => !p.includes("down")).map((p) => [p, { rel: "r", w: 1, h: 1, copy: true }])), failed: list.filter((p) => p.includes("down")) };
    },
  };
  const make = () => {
    const obj = new Function("attach", `return { ${m![0]} };`)(fakeAttach);
    const timers: [number, Function][] = [];
    const tasks: Promise<unknown>[] = [];
    const cx: any = { notify: () => {}, timer: { after: (ms: number, fn: Function) => timers.push([ms, fn]) }, spawn: (fn: Function) => tasks.push(fn(cx)) };
    const self = Object.assign(Object.create(obj), { views: {}, viewAsked: new Set() });
    const flush = async (upTo = 0) => {
      for (let i = 0; i < timers.length; i++) if (timers[i][0] <= upTo) { const [, fn] = timers.splice(i--, 1)[0]; fn(cx); }
      await Promise.all(tasks.splice(0));
    };
    return { self, cx, timers, flush };
  };

  test("found in main.js", () => expect(m).not.toBeNull());

  test("remote paths are asked of the agent's machine once; an unreachable one again after 30 s", async () => {
    const { self, cx, timers, flush } = make();
    calls.length = 0;
    self.needViews(["/mine/box.png"], cx);
    self.needViews(["/there/a.png", "/there/down.png"], cx, "nextgate");
    await flush();
    expect(calls).toEqual([["here", ["/mine/box.png"]], ["nextgate", ["/there/a.png", "/there/down.png"]]]);
    expect(self.views["/there/a.png"].copy).toBe(true);
    // Every render asks again: nothing new is fetched.
    self.needViews(["/there/a.png", "/there/down.png"], cx, "nextgate");
    await flush();
    expect(calls.length).toBe(2);
    expect(timers.map(([ms]) => ms)).toEqual([30_000]);
    await flush(30_000);
    self.needViews(["/there/a.png", "/there/down.png"], cx, "nextgate");
    await flush();
    expect(calls[2]).toEqual(["nextgate", ["/there/down.png"]]);
  });
});
