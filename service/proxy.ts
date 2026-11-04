// fork: proxy mode (FORK.md). A reverse proxy on this machine (Caddy, say) in place of tailscale serve: the proxy
// decides who gets in, and the service believes any request it forwards to 127.0.0.1.
//
//   SHEPHERDR_PROXY_ORIGINS=https://board.example,https://board.example:17889
//       the proxy's public origins, the first one the link Settings › Web shows. Set: proxy mode is on, the service
//       never runs tailscale serve, and a request whose Host is one of these origins' is let in without Tailscale.
//   SHEPHERDR_PROXY_USER=caddy
//       only connections this user opened count as the proxy's (another user here can't just send the Host). Unset:
//       any connection to 127.0.0.1 with that Host gets in.
//
// Unset SHEPHERDR_PROXY_ORIGINS: upstream's behaviour, untouched.
import { readFileSync } from "node:fs";

export type Proxy = { origins: string[]; uid: number | null };

/** The proxy mode the environment asks for, or null (upstream's Tailscale-only way in). Throws on a bad setting. */
export function proxyFrom(env: Record<string, string | undefined> = process.env, passwd?: string): Proxy | null {
  const raw = (env.SHEPHERDR_PROXY_ORIGINS ?? "").trim();
  if (!raw) return null;
  const origins = raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    let u: URL;
    try { u = new URL(s); } catch { throw new Error(`SHEPHERDR_PROXY_ORIGINS: not an origin: ${s}`); }
    if (u.protocol !== "https:" || u.origin !== s.replace(/\/$/, "")) throw new Error(`SHEPHERDR_PROXY_ORIGINS: not an https origin: ${s}`);
    return u.origin;
  });
  const user = (env.SHEPHERDR_PROXY_USER ?? "").trim();
  let uid: number | null = null;
  if (user) {
    if (/^\d+$/.test(user)) uid = Number(user);
    else {
      let text = passwd;
      if (text === undefined) try { text = readFileSync("/etc/passwd", "utf8"); } catch { text = ""; }
      const row = text.split("\n").map((l) => l.split(":")).find((f) => f[0] === user);
      if (!row || !/^\d+$/.test(row[2] ?? "")) throw new Error(`SHEPHERDR_PROXY_USER: no such user: ${user}`);
      uid = Number(row[2]);
    }
  }
  return { origins, uid };
}

/** The proxy origin a request's Host names (as the browser sees it: no :443 on https), or null. */
export function proxyOrigin(req: Request, p: Proxy | null): string | null {
  if (!p) return null;
  const host = (req.headers.get("host") ?? "").toLowerCase().replace(/:443$/, "");
  return p.origins.find((o) => new URL(o).host === host) ?? null;
}

/** The web app's link through the proxy: its first origin's /shepherdr/. */
export const proxyLink = (p: Proxy) => `${p.origins[0]}/shepherdr/`;
