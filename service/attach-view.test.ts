// Window images were empty grey boxes (SHEP-39): the chat's thumbnails and artifact cards get each image's size from
// attach.viewable(), which asks ImageMagick, else ffprobe. ffprobe 8 refuses the space separator it was given
// (csv=s=' '), so on a machine without ImageMagick no image got a size and none was drawn. This runs the real script
// with the real ffprobe on a real PNG, with a magick that fails first on PATH.
import { afterAll, describe, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

mock.module("herdr", () => fakeHerdr({
  exec: async (cmd: string, args: string[]) => {
    const p = Bun.spawnSync([cmd, ...args], { env: { ...process.env, PATH } });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
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
