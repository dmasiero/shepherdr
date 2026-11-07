// fork: SHEP-17. The window chat's rows from a log, built and drawn by the real mod (window-runs/chat-window.js), in a
// bun of its own: bun keeps the first mock of a module's names for the whole run.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("a finished task's chat draws, and Show more on the newest reply opens at Herdr's zoom", () => {
  const r = Bun.spawnSync([process.execPath, "test", "./core/window-runs/chat-window.js"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stderr: "pipe", stdout: "pipe" });
  const out = r.stderr.toString() + r.stdout.toString();
  expect(out).toContain(" 4 pass");
  expect(out).toContain(" 0 fail");
  expect(r.exitCode).toBe(0);
}, 30_000);
