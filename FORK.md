# This fork

[dmasiero/shepherdr](https://github.com/dmasiero/shepherdr) is a GitHub fork of
[eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) ("upstream"). Its line is `3.x`, cut clean from
upstream's tag v3.1.14 (`45521918`) and following upstream's `main`. `main` mirrors upstream's.

renix (Doug's NixOS config) pins and builds `3.x` (`pkgs/shepherdr.nix`, `pkgs/forks.nix`) and runs it on nextgate:
the Herdr window plus the service and its web app at https://board.masiero.internal.

## The layer

Ten changes. Everything else is upstream's; `git diff upstream/main 3.x` shows all of it.

| File | What |
| --- | --- |
| `FORK.md` | This page. |
| `test/test_herdr_artifact_readonly.py`; hook in `mods/artifacts/bin/herdr-artifact` (its `shutil.copyfile`s) | Read-only install: with Shepherdr's files read-only (a Nix store), `herdr-artifact publish` failed with `PermissionError` while staging, since `copy2` kept the read-only mode and the check then rewrote the staged recipe view. Its copies now take only the content ([upstream #749](https://github.com/eliasstravik/shepherdr/issues/749)). |
| `service/proxy.ts`, `service/proxy.test.ts`; hooks in `service/auth.ts`, `service/main.ts`, `service/live.ts`, `service/settings.ts`, `core/settings.js` (and its copies in the mods) | Proxy mode, below: a reverse proxy on this machine instead of Tailscale. |
| `web/src/noSpaces.test.ts`; hooks in `web/src/App.tsx`, `web/src/kernel.ts` | No spaces: with the last space closed the web app shows "No spaces yet" and New space instead of a blank page ([upstream #747](https://github.com/eliasstravik/shepherdr/issues/747)). |
| `service/chat-foreground.test.ts`; hook in `service/chats.ts` (`withForeground`) | Local chats: herdr-core 0.1.18's live list has no foreground for this machine's terminals, so the web chat couldn't find a local agent's log (by its pid) and said "Can't find this conversation". The service now asks `hc get` for local live terminals too, not only other machines'. |
| `core/keyholder.test.js`; hooks in `lib/keyholder.js` (and its copies), `lib/COPIES`, `mods/newspace/main.js`, `mods/chat/main.js` (`draw()`) | New space dialog focus: Herdr still counts the pane under a dialog as focused, so the Assistant chat there took the keyboard back into its box on a redraw (a message arriving, its agent restarting), at random moments. The dialog now holds the keyboard (shared "keyboard.holder", as a dialog) while open and gives it back on close, and the chat takes nothing back while a dialog holds it. |
| `lib/emoji-grid.js` (and its copies), `core/emoji-grid.test.js`; hooks in `lib/COPIES`, `mods/chat-react/main.js`, `mods/spaces-chat/icon.js` | Emoji pickers: the Rename dialog's icon picker (and the chat's reaction picker, its source) worked out which emoji was clicked from the press's `local_position`, which in the window often wasn't from the list's left edge: the click did nothing or picked one about two to the right. Press zones over the list, one per column, now say which column by GPUI's own hit test. |
| `core/parked-sweep.test.js`; hooks in `lib/live.js` (`chatPaneOf`, `paneKey`, `chatKey`), `lib/parked.js`, `lib/coordinator.js`, `lib/unread.js`, `lib/inbox.js` (and their copies), `mods/chat/main.js` | Two windows, one machine's spaces: an agent behind a chat carries `herdr.chat=<pane>` as the window that started it spells the pane (`p…` on the pane's own machine, `m3oracle/p…` in another machine's window). With a window on each machine, each window's sweep of parked agents read the other's spelling as a gone pane and ended its Assistants within 10 s, so a Mac's new spaces kept losing their Assistant and asking to be closed. A chat pane is now matched by its machine and bare id however the label spells it. |
| `mods/chat/termblock.js`, `core/termblock.test.js`; hooks in `mods/chat/panel.js` (`renderHead`), `mods/tasks/main.js` (`openThread`) | Task Terminal: the task view's terminal is one layout block that keeps the last terminal it showed, and a task opened from the Tasks list kept the view on Terminal, so it showed the previous task's agent under the new task's header (SHEP-7 showing TIC-2's). A task now opens on its chat, and the header goes back to the chat whenever the block shows anything but the task's own live agent. |
| `core/tabs-tasks-waits.test.js`; hooks in `mods/tabs-tasks/main.js` (the command loop), `lib/inbox.js` (`startInbox`, and its copies) | Endless waits: the tab bar's command loop (every 5 s) and the inbox engine's watch of new asks (every 4 s) each raced the same pending promise round after round, and each race left a listener on it until a command or an ask came: about 6,500 promise records over 4 quiet hours. The promise now wakes the wait itself, one listener for good (SHEP-9). The window's 17:02 crash itself ("out of memory", then a heap-corruption abort) was Herdr's: herdr-app 0.1.13 loads a mod afresh for every popup, dialog, toast, pane and hot reload and never frees a load, so its one 256 MiB QuickJS heap filled (256 loads alive in the core dump). That needs a Herdr fix. |
| `test/test_remote_install.py`; hooks in `mods/tasks/bin/herdr_task/base.py` (`portable_script`, `bundle`), `mods/tasks/bin/herdr_task/machines.py` (`manifest`, `INSTALL`), `bin/herdr-secret` (`cmd_install`), `mods/artifacts/bin/herdr-artifact` (`remote`), `bin/herdr-browser` | Remote install from a Nix install: the Nix package's patchShebangs points `#!/usr/bin/env python3` and `#!/bin/sh` at Nix store paths, and every copy to another machine (the machine sync, `herdr-secret install --on`, `herdr-artifact --on`) sent them as they were, so herdr-secret, herdr-artifact and herdr-browser didn't run on a Mac. What goes to another machine now gets a portable first line (one helper, `portable_script`; the two helpers that stand alone carry a verbatim copy the test keeps equal), the sync refuses a script whose interpreter isn't there instead of installing it, and herdr-browser falls back to the `agent-browser` on PATH when its baked-in path isn't there. |

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
