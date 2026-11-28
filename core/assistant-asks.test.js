// fork: question cards for Assistants on other machines (core/assistant-asks.js).
import { expect, test } from "bun:test";
import { withAskHook, askCommand, ASKS_LABEL } from "./assistant-asks.js";

const HOOK = "/home/m/.local/share/herdr/ask/ask-hook.sh";
const settingsOf = (argv) => JSON.parse(argv[argv.indexOf("--settings") + 1]);

test("a plain claude gets the hook in a --settings of its own, chained and waiting a week", () => {
  const out = withAskHook(["claude", "--model", "opus"], HOOK);
  expect(out.slice(0, 2)).toEqual(["claude", "--settings"]);
  expect(out.slice(3)).toEqual(["--model", "opus"]);
  expect(settingsOf(out).hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command", command: `HERDR_ASK_CHAINED=1 sh ${HOOK}`, timeout: 604800 }] }]);
});

test("its JSON --settings is kept and merged, never a second --settings; once only", () => {
  const out = withAskHook(["/usr/bin/claude", "--settings", '{"fastMode":true,"hooks":{"Stop":[]}}'], HOOK);
  expect(out.filter((a) => a === "--settings").length).toBe(1);
  const s = settingsOf(out);
  expect(s.fastMode).toBe(true);
  expect(s.hooks.Stop).toEqual([]);
  expect(s.hooks.PermissionRequest.length).toBe(1);
  expect(settingsOf(withAskHook(out, HOOK)).hooks.PermissionRequest.length).toBe(1);
});

test("Codex, no agent, a settings file or no hook: null (left as it is)", () => {
  expect(withAskHook(["codex", "--no-daemon"], HOOK)).toBeNull();
  expect(withAskHook(["sh", "-c", "x"], HOOK)).toBeNull();
  expect(withAskHook(["claude", "--settings", "/home/m/s.json"], HOOK)).toBeNull();
  expect(withAskHook(["claude"], "")).toBeNull();
});

test("a path with a space is quoted for the shell; the label is launch.py's", () => {
  expect(askCommand("/a b/ask-hook.sh")).toBe("HERDR_ASK_CHAINED=1 sh '/a b/ask-hook.sh'");
  expect(ASKS_LABEL).toBe("herdr.asks=chained");
});
