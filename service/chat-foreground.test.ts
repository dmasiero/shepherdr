// fork: a live terminal the live list gives with no foreground (herdr-core 0.1.18 does so for this machine's too)
// gets it from hc get, so its chat can find the agent's log by its pid. A fake hc stands in (SHEPHERDR_HC).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "shep-fg-"));
const calls = join(dir, "calls");
const fake = join(dir, "hc");
writeFileSync(calls, "");
writeFileSync(fake, `#!/bin/sh
echo "$*" >> '${calls}'
[ "$1" = get ] || exit 1
echo '{"address":"'"$2"'","foreground":{"pid":4242,"name":"claude","argv":["claude"],"cwd":"/w"}}'
`);
chmodSync(fake, 0o755);
beforeAll(() => { process.env.SHEPHERDR_HC = fake; });
afterAll(() => { delete process.env.SHEPHERDR_HC; });
const { withForeground } = await import("./chats.ts");
const asked = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);

test("a local live terminal with no foreground gets it from hc get", async () => {
  const t = await withForeground("t1", { address: "t1", state: "live", foreground: null });
  expect(t.foreground?.pid).toBe(4242);
  expect(asked()).toContain("get t1 --json");
});

test("another machine's live terminal still gets it from hc get", async () => {
  const t = await withForeground("vm/t2", { address: "vm/t2", state: "live" });
  expect(t.foreground?.pid).toBe(4242);
  expect(asked()).toContain("get vm/t2 --json");
});

test("a terminal that has its pid, or isn't live, asks nothing", async () => {
  const has = { address: "t3", state: "live", foreground: { pid: 7 } };
  expect(await withForeground("t3", has)).toBe(has);
  const done = { address: "t4", state: "finished", foreground: null };
  expect(await withForeground("t4", done)).toBe(done);
  expect(asked().some((l) => l.includes("t3") || l.includes("t4"))).toBe(false);
});

test("asked again within 10 s: the cached answer, no second hc get", async () => {
  await withForeground("t1", { address: "t1", state: "live", foreground: null });
  expect(asked().filter((l) => l === "get t1 --json").length).toBe(1);
});
