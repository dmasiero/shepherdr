// fork: SHEP-17. The window chat's rows from a log, built and drawn by the real mod (window-runs/chat-window.js), in a
// bun of its own: bun keeps the first mock of a module's names for the whole run.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// fork: SHEP-18 adds every press at the zoom: a question card's pills, Next, options and Submit, a band, Accept, chips.
test("a finished task's chat draws, and its presses land at Herdr's zoom (Show more, cards, bands, Accept)", () => {
  const r = Bun.spawnSync([process.execPath, "test", "./core/window-runs/chat-window.js"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stderr: "pipe", stdout: "pipe" });
  const out = r.stderr.toString() + r.stdout.toString();
  expect(out).toContain(" 10 pass");
  expect(out).toContain(" 0 fail");
  expect(r.exitCode).toBe(0);
}, 30_000);
