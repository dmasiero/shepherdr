# This fork

[dmasiero/shepherdr](https://github.com/dmasiero/shepherdr) is a GitHub fork of
[eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) ("upstream"). Its line is `3.x`, cut clean from
upstream's tag v3.1.14 (`45521918`) and following upstream's `main`. `main` mirrors upstream's.

renix (Doug's NixOS config) pins and builds `3.x` (`pkgs/shepherdr.nix`, `pkgs/forks.nix`) and runs it on nextgate:
the Herdr window plus the service and its web app at https://board.masiero.internal.

## The layer

Three changes. Everything else is upstream's; `git diff upstream/main 3.x` shows all of it.

| File | What |
| --- | --- |
| `FORK.md` | This page. |
| `service/proxy.ts`, `service/proxy.test.ts`; hooks in `service/auth.ts`, `service/main.ts`, `service/live.ts`, `service/settings.ts`, `core/settings.js` (and its copies in the mods) | Proxy mode, below: a reverse proxy on this machine instead of Tailscale. |
| `web/src/noSpaces.test.ts`; hooks in `web/src/App.tsx`, `web/src/kernel.ts` | No spaces: with the last space closed the web app shows "No spaces yet" and New space instead of a blank page ([upstream #747](https://github.com/eliasstravik/shepherdr/issues/747)). |
| `service/chat-foreground.test.ts`; hook in `service/chats.ts` (`withForeground`) | Local chats: herdr-core 0.1.18's live list has no foreground for this machine's terminals, so the web chat couldn't find a local agent's log (by its pid) and said "Can't find this conversation". The service now asks `hc get` for local live terminals too, not only other machines'. |

Upstream's files change only where the layer hooks in, each marked with a `fork:` comment.

### Proxy mode

Upstream lets the web app in only through `tailscale serve`, with Tailscale's identity header. renix serves it through
Caddy over OpenVPN instead, so the service has an opt-in proxy mode:

```sh
SHEPHERDR_PROXY_ORIGINS=https://board.masiero.internal   # the proxy's public origins, comma-separated
SHEPHERDR_PROXY_USER=caddy    # only connections this user opens count (optional, but set it)
```

With `SHEPHERDR_PROXY_ORIGINS` set, a request to 127.0.0.1 whose `Host` is one of those origins' (the proxy passes it
through unchanged), on a connection `SHEPHERDR_PROXY_USER` opened, is let in with no Tailscale and no login. Writes and
sockets still need the `Origin` its `Host` names, and writes the `x-shepherdr` header, so a page on another site can't
act. The service never runs `tailscale serve` then, and Settings › Web's link and QR code are the first origin's
`/shepherdr/`, the phone's push alerts are signed for it, and without Tailscale the machine goes by its host name.
Anything else (no `Host` of the proxy's) is upstream's: the tailnet, or the local token. Unset, nothing changes.

**Warning: this hands all access control to the proxy.** Anyone who can reach the proxy's address can use Shepherdr and
run agents on this machine as you: the proxy (its source filter, a login in front of it) is the only gate. Without
`SHEPHERDR_PROXY_USER`, any user on this machine can reach 127.0.0.1 with the proxy's `Host` and get in too.

## Syncing with upstream

Upstream comes in by merge, never by rebase or squash: the line is published, and a merge keeps upstream's commits as
they are, so the next sync only sees what is new.

```sh
git fetch upstream
git switch -c sync/upstream-<version> origin/3.x
git merge upstream/main          # a conflict is almost always a `fork:` hook line: keep upstream's change, put the hook back
bun install --frozen-lockfile && bun run typecheck && bun test service
gh pr create --base 3.x          # merge it with "Create a merge commit"
```

`renix full` shows how far `3.x` is behind upstream and offers to merge an open `sync/upstream-*` pull request.
