// fork: SHEP-34. The web app's "install isn't whole" bar reads what doctor wrote.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCheck } from "./install-check.ts";

const scratch = () => { const home = mkdtempSync(join(tmpdir(), "install-check-")); const state = join(home, "state"); mkdirSync(state); return { home, state }; };

test("nothing without a verdict, or when whole", () => {
  const { home, state } = scratch();
  expect(installCheck(state, home)).toBeUndefined();
  writeFileSync(join(state, "install-check.json"), JSON.stringify({ whole: true, at: 1 }));
  expect(installCheck(state, home)).toBeUndefined();
  writeFileSync(join(state, "install-check.json"), "not json");
  expect(installCheck(state, home)).toBeUndefined();
});

test("not whole: its problems, since when, and whether the sync is held", () => {
  const { home, state } = scratch();
  writeFileSync(join(state, "install-check.json"), JSON.stringify({ whole: false, at: 5, since: 3, problems: ["shared lib copies differ: x"] }));
  expect(installCheck(state, home)).toEqual({ problems: ["shared lib copies differ: x"], since: 3, held: false });
  writeFileSync(join(state, "sync-hold"), "held\n");
  expect(installCheck(state, home)?.held).toBe(true);
});
