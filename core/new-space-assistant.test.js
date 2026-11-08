// fork: a new space's Assistant on NixOS (SHEP-28). pool.fan's Assistant (t7z) sat on Claude Code's "Do you trust this
// folder?" screen. Nix runs Claude Code as ".claude-wrapped", and with no session yet (no status) that name was all
// there was: the web said "No chat for this agent" and offered no card for the screen. And Claude Code now trusts the
// space's folder before it starts (core/claude-trust.js), run here on a throwaway config.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindOf, progName } from "./chat-reader.js";
import { cliOf, starting } from "./screens.js";
import { TRUST, trustArgv } from "./claude-trust.js";

// t7z as hc showed it on its trust screen: live, no status, turn 0, the wrapper in the foreground
const t7z = { address: "t7z", state: "live", turn: 0, status: null, foreground: { name: ".claude-wrapped", argv: ["claude"] } };

test("Nix's .claude-wrapped is Claude Code, before its session reports itself", () => {
  expect(progName(".claude-wrapped")).toBe("claude");
  expect(progName(".codex-wrapped-wrapped")).toBe("codex");
  expect(progName("fish")).toBe("fish");
  expect(kindOf(t7z)).toBe("claude");
  expect(cliOf(t7z)).toBe("claude");
  expect(cliOf({ ...t7z, agent: "sh" })).toBe("claude");   // hc's name for a template's launch (sh -c '…; exec claude')
  expect(starting(t7z)).toBe(true);
  expect(kindOf({ ...t7z, foreground: { name: "fish" } })).toBe(null);
  expect(starting({ ...t7z, status: { state: "idle", app: "claude-code" } })).toBe(false);
});

const trust = (home, folder, env = {}) => {
  const [cmd, ...args] = trustArgv(folder);
  const r = Bun.spawnSync([cmd, ...args], { env: { PATH: process.env.PATH, HOME: home, ...env } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
const home = () => realpathSync(mkdtempSync(join(tmpdir(), "claude-trust-")));
const config = (h, file = join(h, ".claude.json")) => JSON.parse(readFileSync(file, "utf8"));

test("trusts the space's folder, keeps the rest of Claude Code's config and its mode", () => {
  const h = home(), f = join(h, ".claude.json"), dir = join(h, "dev", "pool.fan");
  mkdirSync(dir, { recursive: true });
  writeFileSync(f, JSON.stringify({ numStartups: 504, projects: { "/elsewhere": { hasTrustDialogAccepted: true, lastCost: 1 } } }, null, 2));
  chmodSync(f, 0o600);
  expect(trust(h, dir)).toEqual({ code: 0, out: "set" });
  const c = config(h);
  expect(c.numStartups).toBe(504);
  expect(c.projects["/elsewhere"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1 });
  expect(c.projects[dir]).toEqual({ hasTrustDialogAccepted: true });
  expect(statSync(f).mode & 0o777).toBe(0o600);
  expect(trust(h, dir)).toEqual({ code: 0, out: "trusted" });
});

test("a folder's entry keeps its fields; ~ and a link resolve to the folder Claude Code sees", () => {
  const h = home(), real = join(h, "dev", "real"), link = join(h, "link");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link);
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ projects: { [real]: { lastCost: 2 } } }));
  expect(trust(h, link).out).toBe("set");
  expect(config(h).projects[real]).toEqual({ lastCost: 2, hasTrustDialogAccepted: true });
  mkdirSync(join(h, "dev", "b"));
  expect(trust(h, "~/dev/b").out).toBe("set");
  expect(config(h).projects[join(h, "dev", "b")].hasTrustDialogAccepted).toBe(true);
});

test("never the home folder or /, never a config that isn't there or isn't JSON", () => {
  const h = home();
  expect(trust(h, h).out).toBe("skipped");
  expect(trust(h, "/").out).toBe("skipped");
  expect(trust(h, join(h, "x"))).toEqual({ code: 0, out: "none" });
  writeFileSync(join(h, ".claude.json"), "{ half");
  expect(trust(h, join(h, "x"))).toEqual({ code: 1, out: "busy" });
  expect(readFileSync(join(h, ".claude.json"), "utf8")).toBe("{ half");
});

test("CLAUDE_CONFIG_DIR's config, when set", () => {
  const h = home(), d = join(h, "cfg");
  mkdirSync(d);
  writeFileSync(join(d, ".claude.json"), "{}");
  expect(trust(h, join(h, "p"), { CLAUDE_CONFIG_DIR: d }).out).toBe("set");
  expect(config(h, join(d, ".claude.json")).projects[join(h, "p")].hasTrustDialogAccepted).toBe(true);
});

test("the script is the one the service and the window run", () => {
  expect(trustArgv("/a")).toEqual(["python3", "-c", TRUST, "/a"]);
});
