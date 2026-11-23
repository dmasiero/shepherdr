// fork: the "@~/" and "@/" list over the web app's message box (SHEP-50, core/path-pick.js): a folder's entries on
// the machine that runs a chat's agent. api/paths in service/main.ts answers with it.
import * as PP from "../core/path-pick.js";

const P = PP as any;
type Run = (script: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** The machine a chat's agent runs on: its address's (a chat with no agent yet: its space's); null is this one. */
export function machineOfChat(key: string, addrOf: (k: string) => string | null, spaceOf: (k: string) => { machine?: string | null } | undefined): string | null {
  const a = addrOf(key);
  if (a) return a.includes("/") ? a.split("/")[0]! : null;
  return spaceOf(key)?.machine ?? null;
}

/** A folder's entries ("~/dev/", "/etc/"), as LIST prints them; null for a folder that is neither under home nor the
 *  root. One that isn't there (or can't be read) lists nothing. */
export async function listPaths(run: Run, dir: string): Promise<string[] | null> {
  const w = P.whereOf(dir) as [string, string] | null;
  if (!w) return null;
  const r = await run(P.LIST, ["x", ...w]).catch(() => null);
  return r?.code === 0 ? (P.entriesOf(r.stdout) as string[]) : [];
}
