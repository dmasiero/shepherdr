import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execTemplate } from "./spaces.ts";

// #1051: a space's Assistant started from the web ran the stock template's `claude`, whatever Settings › Agents chose.
// A hub whose machine.exec runs here, with HOME a throwaway (its templates folder) and PATH only the CLIs given.
function machine(clis: string[]) {
  const home = mkdtempSync(join(tmpdir(), "shep-assistant-start-")), bin = join(home, "bin"), dir = join(home, ".config", "herdr-core", "templates");
  mkdirSync(bin); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assistant.md"), "---\nname: assistant\ndescription: The Assistant\ncommand: claude\n---\nYou are the Assistant.\n");
  for (const c of clis) { writeFileSync(join(bin, c), "#!/bin/sh\n"); chmodSync(join(bin, c), 0o755); }
  // a host whose /usr/bin has none of these to a narrowed PATH (NixOS's envfs): linked in, as AGENTS.md says
  for (const t of ["sh", "cat", "rm", "printf"]) { const p = Bun.which(t); if (p) symlinkSync(p, join(bin, t)); }
  const hub: any = {
    call: async (_: string, a: { argv: string[] }) => {
      // hermetic: where agents install system-wide (core/clean-env.js AGENT_PATH) left out, this VM has them there
      const argv = a.argv.map((x) => x.replace(":/opt/homebrew/bin:/usr/local/bin", ""));
      const p = Bun.spawnSync(argv, { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } });
      const b64 = (x: Uint8Array) => Buffer.from(x).toString("base64");
      return { code: p.exitCode, stdout: b64(p.stdout), stderr: b64(p.stderr) };
    },
  };
  const made = () => readdirSync(dir).filter((f) => f !== "assistant.md").map((f) => readFileSync(join(dir, f), "utf8"));
  return { hub, made, home };
}
const commandOf = (file: string) => /^command:(.*)$/m.exec(file)?.[1] ?? "";

test("the Assistant runs the agent its settings choose, with its model, effort and permissions", async () => {
  const { hub, made } = machine(["codex"]);
  const t = await execTemplate(hub, "assistant", null, { agent: "codex", model: "gpt-5.5", effort: "high", fast: false, perm: "full" });
  const [file] = made();
  expect(commandOf(file)).toContain("exec codex --no-daemon -m gpt-5.5");
  expect(commandOf(file)).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(commandOf(file)).not.toMatch(/exec claude/);
  expect(t.words).toBe("You are the Assistant.");
});

test("no choice: the template's own command, as before", async () => {
  const { hub, made } = machine(["claude"]);
  await execTemplate(hub, "assistant", null, null);
  expect(commandOf(made()[0])).toMatch(/exec claude\s*$/);
});

test("the chosen agent missing there: the template's own; neither there: a plain refusal, never a dead start", async () => {
  const a = machine(["claude"]);
  await execTemplate(a.hub, "assistant", null, { agent: "codex", model: null, effort: null, fast: false, perm: "auto" });
  expect(commandOf(a.made()[0])).toMatch(/exec claude\s*$/);
  const b = machine([]);
  await expect(execTemplate(b.hub, "assistant", null, { agent: "codex", perm: "full" })).rejects.toThrow("Codex isn't installed on this computer");
  expect(b.made()).toEqual([]);
});

// fork: question cards for Assistants on other machines. A machine that only runs tasks has no Shepherdr hook in its
// ~/.claude/settings.json, only the copy a sync leaves in ~/.local/share/herdr/ask/: its Claude Assistant gets that
// one in its own --settings, labelled so a global copy there steps aside; this computer's, Codex and a machine
// without the copy are left as before.
function withHook(_: ReturnType<typeof machine>, home: string) {
  mkdirSync(join(home, ".local", "share", "herdr", "ask"), { recursive: true });
  writeFileSync(join(home, ".local", "share", "herdr", "ask", "ask-hook.sh"), "#!/bin/sh\n");
  return join(home, ".local", "share", "herdr", "ask", "ask-hook.sh");
}

test("a Claude Assistant on another machine gets the synced hook in its --settings, and the label", async () => {
  const m = machine(["claude"]);
  const hook = withHook(m, m.home);
  const t = await execTemplate(m.hub, "assistant", "m3", null);
  const cmd = commandOf(m.made()[0]);
  expect(cmd).toContain("exec claude --settings ");
  expect(cmd).toContain(`HERDR_ASK_CHAINED=1 sh ${hook}`);
  expect(cmd).toContain('"timeout":604800');
  expect(t.labels).toEqual(["--label", "herdr.asks=chained"]);
});

test("its speed's --settings keeps fastMode, merged with the hook", async () => {
  const m = machine(["claude"]);
  withHook(m, m.home);
  await execTemplate(m.hub, "assistant", "m3", { agent: "claude", model: "opus", fast: true, perm: "auto" });
  const cmd = commandOf(m.made()[0]);
  expect(cmd.match(/--settings/g)?.length).toBe(1);
  expect(cmd).toContain('"fastMode":true');
  expect(cmd).toContain("PermissionRequest");
});

test("this computer, a Codex Assistant, or a machine without the hook: no hook, no label", async () => {
  const here = machine(["claude"]);
  withHook(here, here.home);
  expect((await execTemplate(here.hub, "assistant", null, null)).labels).toEqual([]);
  expect(commandOf(here.made()[0])).not.toContain("PermissionRequest");
  const codex = machine(["codex"]);
  withHook(codex, codex.home);
  expect((await execTemplate(codex.hub, "assistant", "m3", { agent: "codex", perm: "full" })).labels).toEqual([]);
  expect(commandOf(codex.made()[0])).not.toContain("PermissionRequest");
  const none = machine(["claude"]);
  expect((await execTemplate(none.hub, "assistant", "m3", null)).labels).toEqual([]);
  expect(commandOf(none.made()[0])).not.toContain("PermissionRequest");
});
