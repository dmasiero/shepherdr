// fork: SHEP-34. The install on this machine isn't whole: what `shepherdr doctor` found last (install-check.json in
// Shepherdr's state folder, bin/shepherdr write_check), for the web app's top bar. On nextgate an older Shepherdr's
// leftovers failed doctor for three days, the sync to other machines stayed held, and nothing said so.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOME, where } from "./paths.ts";
import type { InstallHeld } from "../web/shared/types.ts";

/** doctor's last verdict when it wasn't whole, else undefined. held: the sync to other machines waits on it. */
export function installCheck(state = where().roots.state, home = HOME): InstallHeld | undefined {
  let d: any;
  try { d = JSON.parse(readFileSync(join(state, "install-check.json"), "utf8")); } catch { return undefined; }
  if (!d || d.whole !== false || !Array.isArray(d.problems) || !d.problems.length) return undefined;
  const held = existsSync(join(state, "sync-hold")) || existsSync(join(home, ".herdr", "sync-hold"));
  return { problems: d.problems.filter((x: unknown) => typeof x === "string").slice(0, 20), since: Number(d.since ?? d.at) || 0, held };
}
