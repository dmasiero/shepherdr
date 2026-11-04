// fork: proxy mode (service/proxy.ts, FORK.md)
import { describe, expect, test } from "bun:test";
import { gate, type Gate } from "./auth.ts";
import { proxyFrom, proxyOrigin, proxyLink } from "./proxy.ts";
import * as S from "../core/settings.js";

const PASSWD = "root:x:0:0::/root:/bin/sh\ncaddy:x:239:239::/var/lib/caddy:/sbin/nologin\n";
const origins = "https://board.example,https://board.example:17889";
const proxy = proxyFrom({ SHEPHERDR_PROXY_ORIGINS: origins, SHEPHERDR_PROXY_USER: "caddy" }, PASSWD)!;
const g: Gate = { owner: null, dns: null, port: 7788, token: "secret-token", proxy };
const via = (host: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new Request(`http://${host}/api/me`, { method: init.method ?? "GET", headers: { host, ...init.headers } });
const write = (host: string, origin: string, extra: Record<string, string> = {}) =>
  via(host, { method: "POST", headers: { origin, "x-shepherdr": "1", ...extra } });

describe("the setting", () => {
  test("unset or empty: upstream's way in", () => {
    expect(proxyFrom({})).toBeNull();
    expect(proxyFrom({ SHEPHERDR_PROXY_ORIGINS: " " })).toBeNull();
  });
  test("origins and the proxy's user", () => {
    expect(proxy).toEqual({ origins: ["https://board.example", "https://board.example:17889"], uid: 239 });
    expect(proxyFrom({ SHEPHERDR_PROXY_ORIGINS: "https://board.example/" })).toEqual({ origins: ["https://board.example"], uid: null });
    expect(proxyFrom({ SHEPHERDR_PROXY_ORIGINS: "https://board.example", SHEPHERDR_PROXY_USER: "1001" })!.uid).toBe(1001);
    expect(proxyLink(proxy)).toBe("https://board.example/shepherdr/");
  });
  test("anything else is refused, not guessed", () => {
    expect(() => proxyFrom({ SHEPHERDR_PROXY_ORIGINS: "http://board.example" })).toThrow();
    expect(() => proxyFrom({ SHEPHERDR_PROXY_ORIGINS: "https://board.example/shepherdr" })).toThrow();
    expect(() => proxyFrom({ SHEPHERDR_PROXY_ORIGINS: "board.example" })).toThrow();
    expect(() => proxyFrom({ SHEPHERDR_PROXY_ORIGINS: origins, SHEPHERDR_PROXY_USER: "nobody" }, PASSWD)).toThrow();
  });
  test("the Host names an origin as the browser sees it", () => {
    expect(proxyOrigin(via("board.example"), proxy)).toBe("https://board.example");
    expect(proxyOrigin(via("board.example:443"), proxy)).toBe("https://board.example");
    expect(proxyOrigin(via("BOARD.example:17889"), proxy)).toBe("https://board.example:17889");
    expect(proxyOrigin(via("board.example:17890"), proxy)).toBeNull();
    expect(proxyOrigin(via("board.example"), null)).toBeNull();
  });
});

describe("through the proxy", () => {
  test("reads without Tailscale or a token", () =>
    expect(gate(via("board.example"), g, false, true)).toMatchObject({ ok: true, via: "proxy" }));
  test("a connection the proxy's user didn't open is refused", () =>
    expect(gate(via("board.example"), g, false, false)).toMatchObject({ ok: false, status: 403 }));
  test("a write needs the origin its Host names, and the header", () => {
    expect(gate(write("board.example", "https://board.example"), g, false, true)).toMatchObject({ ok: true });
    expect(gate(write("board.example:17889", "https://board.example:17889"), g, false, true)).toMatchObject({ ok: true });
    expect(gate(write("board.example:17889", "https://board.example"), g, false, true)).toMatchObject({ ok: false, status: 403 });
    expect(gate(write("board.example", "https://evil.example"), g, false, true)).toMatchObject({ ok: false, status: 403 });
    expect(gate(via("board.example", { method: "POST", headers: { origin: "https://board.example" } }), g, false, true)).toMatchObject({ ok: false, status: 403 });
  });
  test("a socket needs the origin too", () => {
    expect(gate(via("board.example:17889", { headers: { origin: "https://board.example:17889" } }), g, true, true)).toMatchObject({ ok: true });
    expect(gate(via("board.example:17889", { headers: { origin: "https://evil.example" } }), g, true, true)).toMatchObject({ ok: false });
    expect(gate(via("board.example:17889"), g, true, true)).toMatchObject({ ok: false });
  });
  test("cross-site and preflight requests are still refused", () => {
    expect(gate(via("board.example", { headers: { "sec-fetch-site": "cross-site" } }), g, false, true)).toMatchObject({ ok: false });
    expect(gate(via("board.example", { method: "OPTIONS" }), g, false, true)).toMatchObject({ ok: false });
  });
  test("another host name still needs the token (DNS rebinding)", () =>
    expect(gate(via("evil.example"), g, false, true)).toMatchObject({ ok: false, status: 421 }));
  test("this machine's callers keep their token", () =>
    expect(gate(new Request("http://127.0.0.1:7788/api/me", { headers: { host: "127.0.0.1:7788", authorization: "Bearer secret-token" } }), g)).toMatchObject({ ok: true, via: "local" }));
  test("off (upstream's default): the proxy's Host gets nothing", () =>
    expect(gate(via("board.example"), { ...g, proxy: null }, false, true)).toMatchObject({ ok: false, status: 421 }));
});

test("Settings › Web says the proxy decides who gets in", () => {
  expect(S.webState(false, true, { on: true, via: "proxy" })).toBe("On, through this machine's reverse proxy: it decides who gets in.");
  expect(S.webState(false, true, { on: true })).toBe("On, private to your tailnet.");
});
