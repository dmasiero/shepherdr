// fork: a Claude Assistant on another machine asks on the chat's card (question cards for Assistants on other machines).
// The chat's question, permission and plan cards come from Claude Code's PermissionRequest hook (hooks/ask-hook.sh).
// Shepherdr's install puts it in ~/.claude/settings.json on its own machine, but a machine that only runs tasks has no
// install there, only the copy a herdr-task sync leaves in ~/.local/share/herdr/ask/ (herdr_task/base.py ASK_HOME): a
// task worker gets it through its own --settings (launch.py own_argv), and so does a space's Assistant now, through
// Claude Code's documented --settings flag at its start, never by editing that machine's ~/.claude. The Assistant is
// labelled herdr.asks=chained, as a worker is (launch.py ASKS_LABEL): a machine that has the global hook too sees that
// label and its global copy steps aside, so one ask never shows two cards. Codex Assistants are left as they are.

/** The label a Claude agent with its own copy of the hook carries (herdr_task/launch.py ASKS_LABEL). */
export const ASKS_LABEL = "herdr.asks=chained";
/** How long Claude waits on the hook: as the card waits, up to a week (herdr_task/launch.py ASK_TIMEOUT). */
export const ASK_TIMEOUT = 604800;
/** Run on the machine (sh -c): prints the synced hook's path when it is there, else nothing. */
export const ASK_HOOK_SH = 'h="$HOME/.local/share/herdr/ask/ask-hook.sh"; [ -f "$h" ] && printf %s "$h"';

const quote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);

/** The hook's command as Claude Code runs it: marked chained, so it never steps aside for itself. */
export const askCommand = (hook) => `HERDR_ASK_CHAINED=1 sh ${quote(hook)}`;

/** Where argv's claude word is (a terminal's argv may start with env, nice or sh -c), or -1. */
function claudeAt(argv) {
  return argv.findIndex((a, i) => (i === 0 || !String(a).startsWith("-")) && String(a).split("/").pop() === "claude");
}

/** argv (a Claude start) with the hook at `hook` in its --settings, merged into the JSON one it has, else in a
 *  --settings of its own; null when it isn't Claude's, or its --settings is a file (left as it is: no hook). */
export function withAskHook(argv, hook) {
  const out = [...(argv ?? [])];
  const at = claudeAt(out);
  if (at < 0 || !hook) return null;
  const entry = { hooks: [{ type: "command", command: askCommand(hook), timeout: ASK_TIMEOUT }] };
  const i = out.indexOf("--settings", at + 1);
  let cur = {};
  if (i >= 0) {
    try { cur = JSON.parse(out[i + 1]); } catch { return null; }
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
  }
  const hooks = cur.hooks && typeof cur.hooks === "object" && !Array.isArray(cur.hooks) ? { ...cur.hooks } : {};
  const asks = Array.isArray(hooks.PermissionRequest) ? [...hooks.PermissionRequest] : [];
  const has = asks.some((e) => (e?.hooks ?? []).some((h) => String(h?.command ?? "").includes(hook)));
  if (!has) asks.push(entry);
  const merged = JSON.stringify({ ...cur, hooks: { ...hooks, PermissionRequest: asks } });
  if (i >= 0) out[i + 1] = merged;
  else out.splice(at + 1, 0, "--settings", merged);
  return out;
}
