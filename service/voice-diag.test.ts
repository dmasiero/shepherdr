// SHEP-45: an Android web call that stopped hearing the person with another app in front or the screen off. The call
// writes a line in service.log every few seconds (how many microphone frames came, how loud; no sound is kept) and
// one at once when the page says its microphone changed: "no frames" and "frames of silence" are told apart.
import { expect, test } from "bun:test";
import { micStats, pageDiag, diagWords, voiceCall } from "./voice.ts";

const pcm = (n: number, v: number) => new Uint8Array(new Int16Array(n).fill(v).buffer);

test("a stretch's frames: how many, the rate, and how loud; none says so", () => {
  const s = micStats();
  expect(s.line(5)).toBe("no frames");
  for (let i = 0; i < 10; i++) s.add(pcm(1365, 3277));
  expect(s.line(5)).toBe("10 frames (2.0/s, 0.9 s of sound), level 10.0% peak 10.0%");
  // each line starts a fresh stretch; silence is 0.0%
  s.add(pcm(1365, 0));
  expect(s.line(1)).toBe("1 frames (1.0/s, 0.1 s of sound), level 0.0% peak 0.0%");
});

test("the page's word is checked: only known states, never free text into the log", () => {
  const d = pageDiag({ event: "mic-mute", vis: "hidden", mic: "live", trackMuted: true, ctx: "running", capture: "worklet", muted: false, sent: 3 });
  expect(diagWords(d)).toBe("page hidden, mic live (track muted), audio running, worklet, page sent 3");
  const bad = pageDiag({ event: "x\nforged line", vis: "<script>", mic: 7, ctx: "running\n", capture: null, sent: "a lot" });
  expect(bad).toEqual({ event: "tick", vis: "?", mic: "?", trackMuted: false, ctx: "?", capture: "?", muted: false, sent: null });
});

test("a call logs its frames every few seconds with the page's state, and a change at once", async () => {
  const lines: string[] = [];
  const page = { send() {}, close() {} };
  // the voice agent never answers: the page's frames still count
  const call = voiceCall({} as any, { io: {} as any, hear: { snap: () => null, view: () => null, follow: () => ({ stop() {} }) } as any,
    where: { client: "web" } as any, dial: () => new Promise(() => {}), log: (l) => lines.push(l), diagMs: 200 }, page);
  const tag = `voice call ${call.id.slice(0, 8)}`;
  await Bun.sleep(250);
  expect(lines).toEqual([`${tag}: no frames; page said nothing yet`]);
  call.message(JSON.stringify({ type: "diag", event: "hidden", vis: "hidden", mic: "live", trackMuted: false, ctx: "running", capture: "worklet", sent: 0 }));
  expect(lines.at(-1)).toBe(`${tag}: hidden; page hidden, mic live, audio running, worklet, page sent 0`);
  for (let i = 0; i < 4; i++) call.message(Buffer.from(pcm(1365, 0)));
  await Bun.sleep(200);
  expect(lines.at(-1)).toMatch(new RegExp(`^${tag}: 4 frames \\(.*\\), level 0\\.0% peak 0\\.0%; page hidden, mic live, audio running, worklet, page sent 0, said 0 s ago$`));
  // the page's socket down: the call holds, and says so
  call.detach(page);
  await Bun.sleep(200);
  expect(lines.at(-1)).toBe(`${tag}: no frames; page's socket down (holding)`);
  const n = lines.length;
  call.end();
  await Bun.sleep(250);
  expect(lines.length).toBe(n);
});
