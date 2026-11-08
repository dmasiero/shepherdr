# This fork

[dmasiero/shepherdr](https://github.com/dmasiero/shepherdr) is a GitHub fork of
[eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) ("upstream"). Its line is `3.x`, cut clean from
upstream's tag v3.1.14 (`45521918`) and following upstream's `main`. `main` mirrors upstream's.

renix (Doug's NixOS config) pins and builds `3.x` (`pkgs/shepherdr.nix`, `pkgs/forks.nix`) and runs it on nextgate:
the Herdr window plus the service and its web app at https://board.masiero.internal.

## The layer

Eighteen changes. Everything else is upstream's; `git diff upstream/main 3.x` shows all of it.

| File | What |
| --- | --- |
| `FORK.md` | This page. |
| `flake.nix`, `flake.lock`, `scripts/sync-upstream.sh`, `scripts/fork_layer.py`, `test/test_sync_upstream.py` | Upstream comes in by itself: `renix full` runs the sync script in the dev shell and merges its pull request (below, "Syncing with upstream"). The dev shell has what the script and its checks need (Bun pinned at the Check workflow's 1.4.2, Node, Python, git, gh, jq); `scripts/fork_layer.py` reads this table for the layer's tests and checks that every hook below still has its `fork:` comment. |
| `test/test_herdr_artifact_readonly.py`; hook in `mods/artifacts/bin/herdr-artifact` (its `shutil.copyfile`s) | Read-only install: with Shepherdr's files read-only (a Nix store), `herdr-artifact publish` failed with `PermissionError` while staging, since `copy2` kept the read-only mode and the check then rewrote the staged recipe view. Its copies now take only the content ([upstream #749](https://github.com/eliasstravik/shepherdr/issues/749)). |
| `service/proxy.ts`, `service/proxy.test.ts`; hooks in `service/auth.ts`, `service/main.ts`, `service/live.ts`, `service/settings.ts`, `core/settings.js` (and its copies in the mods), `service/chats.test.ts`, `service/show.test.ts` (`new Live`: its arguments) | Proxy mode, below: a reverse proxy on this machine instead of Tailscale. |
| `web/src/noSpaces.test.ts`; hooks in `web/src/App.tsx`, `web/src/kernel.ts` | No spaces: with the last space closed the web app shows "No spaces yet" and New space instead of a blank page ([upstream #747](https://github.com/eliasstravik/shepherdr/issues/747)). |
| `service/chat-foreground.test.ts`; hook in `service/chats.ts` (`withForeground`) | Local chats: herdr-core 0.1.18's live list has no foreground for this machine's terminals, so the web chat couldn't find a local agent's log (by its pid) and said "Can't find this conversation". The service now asks `hc get` for local live terminals too, not only other machines'. |
| `core/keyholder.test.js`; hooks in `lib/keyholder.js` (and its copies), `lib/COPIES`, `mods/newspace/main.js`, `mods/chat/main.js` (`draw()`) | New space dialog focus: Herdr still counts the pane under a dialog as focused, so the Assistant chat there took the keyboard back into its box on a redraw (a message arriving, its agent restarting), at random moments. The dialog now holds the keyboard (shared "keyboard.holder", as a dialog) while open and gives it back on close, and the chat takes nothing back while a dialog holds it. |
| `lib/emoji-grid.js` (and its copies), `core/emoji-grid.test.js`; hooks in `lib/COPIES`, `mods/chat-react/main.js`, `mods/spaces-chat/icon.js` | Emoji pickers: the Rename dialog's icon picker (and the chat's reaction picker, its source) worked out which emoji was clicked from the press's `local_position`, which in the window often wasn't from the list's left edge: the click did nothing or picked one about two to the right. Press zones over the list, one per column, now say which column by GPUI's own hit test. |
| `core/parked-sweep.test.js`; hooks in `lib/live.js` (`chatPaneOf`, `paneKey`, `chatKey`), `lib/parked.js`, `lib/coordinator.js`, `lib/unread.js`, `lib/inbox.js` (and their copies), `mods/chat/main.js` | Two windows, one machine's spaces: an agent behind a chat carries `herdr.chat=<pane>` as the window that started it spells the pane (`p…` on the pane's own machine, `m3oracle/p…` in another machine's window). With a window on each machine, each window's sweep of parked agents read the other's spelling as a gone pane and ended its Assistants within 10 s, so a Mac's new spaces kept losing their Assistant and asking to be closed. A chat pane is now matched by its machine and bare id however the label spells it. |
| `mods/chat/termblock.js`, `core/termblock.test.js`; hooks in `mods/chat/panel.js` (`renderHead`), `mods/tasks/main.js` (`openThread`) | Task Terminal: the task view's terminal is one layout block that keeps the last terminal it showed, and a task opened from the Tasks list kept the view on Terminal, so it showed the previous task's agent under the new task's header (SHEP-7 showing TIC-2's). A task now opens on its chat, and the header goes back to the chat whenever the block shows anything but the task's own live agent. |
| `core/tabs-tasks-waits.test.js`; hooks in `mods/tabs-tasks/main.js` (the command loop), `lib/inbox.js` (`startInbox`, and its copies) | Endless waits: the tab bar's command loop (every 5 s) and the inbox engine's watch of new asks (every 4 s) each raced the same pending promise round after round, and each race left a listener on it until a command or an ask came: about 6,500 promise records over 4 quiet hours. The promise now wakes the wait itself, one listener for good (SHEP-9). The window's 17:02 crash itself ("out of memory", then a heap-corruption abort) was Herdr's: herdr-app 0.1.13 loads a mod afresh for every popup, dialog, toast, pane and hot reload and never frees a load, so its one 256 MiB QuickJS heap filled (256 loads alive in the core dump). That needs a Herdr fix. |
| `mods/chat/zoom.js`, `core/chat-zoom.test.js`; hooks in `mods/chat/main.js` (`draw()`, `measurer`) | Window chat gaps: Herdr reports a measured size (`on_size_change`) in pixels at the person's zoom (settings.json `zoom`), but places a virtual list's rows by sizes at zoom 1. The chat's measurer handed the reported heights to its list as they were, so at Doug's zoom 1.7 every row got 1.7 times its height: a blank of 0.7 times the row under each one (316 px under an opened tools row in his tickets Assistant, 165 under a one-line message; the screenshot's blanks match that to a few pixels). The heights now go to the list at zoom 1, and are measured again when the zoom changes. SHEP-11 (reverted) blamed the measurer's copy and registered `on_size_change` on each row inside the list's renderer, where Herdr throws on any handler (gpui-kit.d.ts: "No handlers inside the renderer"), so the window showed nothing; the test keeps the renderer free of handlers. Widths reported at the zoom (`this.width`, used with pointer positions) are left as they were. |
| `test/test_remote_install.py`; hooks in `mods/tasks/bin/herdr_task/base.py` (`portable_script`, `bundle`), `mods/tasks/bin/herdr_task/machines.py` (`manifest`, `INSTALL`), `bin/herdr-secret` (`cmd_install`), `mods/artifacts/bin/herdr-artifact` (`remote`), `bin/herdr-browser` | Remote install from a Nix install: the Nix package's patchShebangs points `#!/usr/bin/env python3` and `#!/bin/sh` at Nix store paths, and every copy to another machine (the machine sync, `herdr-secret install --on`, `herdr-artifact --on`) sent them as they were, so herdr-secret, herdr-artifact and herdr-browser didn't run on a Mac. What goes to another machine now gets a portable first line (one helper, `portable_script`; the two helpers that stand alone carry a verbatim copy the test keeps equal), the sync refuses a script whose interpreter isn't there instead of installing it, and herdr-browser falls back to the `agent-browser` on PATH when its baked-in path isn't there. |
| `core/section-drag.test.js`, `core/window-runs/section-drag.js`; hooks in `core/spaces.js` (`sectionMoved`, `withSectionOrder`, and its copies), `core/spaces.test.js`, `mods/spaces-chat/main.js` (`sectionHead`, `liftOver`, `release`), `mods/spaces-chat/sections.js` (`moveSection`), `service/actions.ts` (`order`), `service/saved-spaces.test.ts`, `web/plugins/places/client.tsx` (`SectionHeading`, `Heading`, `EmptySection`) | Section order: sections showed in the order they were made. A machine's sections now drag by their header among that machine's own, in the window (the drop line, as a space's) and on the web (the rows make room, as a space's; a finger holds first on a phone), and Alt+Shift+↑/↓ on a heading moves it one step on the web, as on a space. Both write the shared "spaces-chat" sections through one core helper, the web by its existing `order` action, which now keeps other machines' sections where they were. A click still folds, a right-click still opens the menu; Pinned and the machines keep their place (SHEP-14). |
| `test/test_herdr_task.py` (`WrappedLaunchStaysAlive`); hooks in `mods/tasks/bin/herdr_task/agents.py` (`agent_running`, `launching`), `mods/tasks/bin/herdr_task/sessions.py` (`refresh_sessions`), `mods/tasks/bin/herdr_task/tick.py` (`retry_pass`) | Agent stopped while alive: a worker starts in the person's shell (`fish -ic '<agent>; exec fish -i'`, behind the low-priority scope and nice). fish keeps the agent as its child in fish's own process group, so hc's foreground stays `fish` for the agent's whole run, and `agent_running()` read a shell as "the agent exited". The task's watcher then marked the agent ended a minute on, dated when it first looked (105 ms after launch on TIC-3), its status said "Needs you · Agent stopped" and its news said failed, while the agent worked on. A shell still running its `-c` launch command now counts as the agent at work; it stops once the shell has `exec`ed into `fish -i` or the terminal is gone, the same for wrapped and plain launches (bash -ic gives the agent a group of its own, so it was never hit). A task already marked ended whose agent still runs drops that mark on the scheduler's next pass (SHEP-16). |
| `core/chat-window.test.js`, `core/window-runs/chat-window.js`; hooks in `mods/chat/main.js` (`mentioned`, `edges`, `clickRow`), `mods/chat/zoom.js` (`atZoom1`) | Window chat, two bugs (SHEP-17). A task's chat opened after its agent ended (INF-6) showed "This view could not be re-rendered … cannot read property 'get' of undefined": such a chat never reads its terminal, so it never loads its tasks, and `mentioned()` kept its cache Map only when `this.tasks` changed; both were undefined, no Map was made, and the first message's `.get` threw. The Map is now made when missing. Show more never opened at Doug's zoom 1.7 (MASI-1's newest reply, the only one that folded): `clickRow()` took the press and the pane's width as Herdr reports them, at the zoom, but the column's edge and padding are at zoom 1, so in a 1130 px pane the press landed about 140 px left of the words. Both now go to zoom 1 first; SHEP-18, below, does the same for every other press. |
| `core/chat-window.test.js`, `core/window-runs/chat-window.js` (the presses); hooks in `mods/chat/main.js` (`pointer`, `edges`, `hitBar`, `clickRow`) | Window chat presses at the zoom (SHEP-18): Submit on MASI-1's three-question card did nothing at Doug's zoom 1.7. Rows take no handlers, so a press on a card's control, a band's button, a Ready line's Accept, a task chip or a thumbnail is found from where the press was; Herdr reports that press, the pane's width and each control's measured width at its zoom, and the column is laid out at zoom 1. The options (whole-width rows) still took presses and the picks counted, so Submit was enabled, but its place, right-aligned, was looked for about 145 px left of where it is drawn at 1.7 in a 1130 px pane (the step pills and Next missed too). One helper, `pointer()`, now gives the press, the pane's width and the measured widths at zoom 1, and `edges()` works from it, so every press test, and the bands and thumbnails drawn from `edges()`, use one frame. The emoji picker's anchor goes back to the zoom with the press it is placed by. Other sizes taken from `this.width` (a bubble's widest, row guesses, viewers' sizes) are as they were. |
| `web/plugins/terminal/input.ts`, `web/plugins/terminal/input.test.ts`, `web/plugins/terminal/screen.test.ts`; hooks in `web/plugins/terminal/client.tsx` (`TerminalView`: `inputOf`, the touch box, `keys`, the key row; `Screen`: `pin`, its resize observer, `connectTerminal`'s cursor mode), `web/plugins/terminal/screen.ts` (`inputOf`, `atEnd`, `toEnd`), `web/plugins/terminal/stream.ts` (`input`) | Web terminal on a phone or tablet (SHEP-19, 20, 22, 23). A tap brings up the keyboard in every terminal, not only a task's: a tablet-wide view (an Android phone in landscape, Chrome's desktop site) gave an Assistant or tab terminal neither the hidden box nor the desktop's keys, so no keyboard came (`inputOf`). Enter and the key row went by herdr-core's `terminal.keys`, which waits for a person to pause (about 3 s after typed text), so Enter after typing lagged; a person's keys now go as a terminal's bytes on the same stream as their text, in order, the cursor keys by the program's cursor mode (`input.ts`), and the box leaves a word the keyboard is composing alone, types only what changed and catches Backspace on an empty box. The keyboard coming up hid the prompt: the screen follows its end as it shrinks, and a tap or a key brings it to the prompt (`pin`, `toEnd`). A key-row press took the focus from the box and closed the keyboard: a press now keeps the focus there; and the row has sticky Ctrl and Alt: a tap engages one (shown filled) for the next key or letter only (Ctrl then `l` is `ctrl+l`, Ctrl then ↑ `ctrl+up`), a second tap lets it go, with no lock. A modified key goes as xterm's bytes too (`CSI 1;5A`, Esc first for Alt). |
| `FORK.md` (this row); hooks in `test/test_herdr_artifact_show.py` (`setUp`), `test/test_restart.py` (`run_script`) | Upstream's tests on NixOS: these two run a command with PATH narrowed to its fake bin and `/usr/bin:/bin`, which on nextgate (envfs: `/usr/bin` shows a tool only to a caller whose PATH has it) finds no `git`, `tail` or `jq`, so they failed in the sync's check. The tools they need are linked into the fake bin from the caller's PATH, as AGENTS.md says. |

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

`renix full` (on nextgate) does it, once renix's `pkgs/forks.nix` names this script (`syncScript`): when `3.x` is
behind upstream's `main` it runs `scripts/sync-upstream.sh` in the dev shell from its clone of the fork, and merges
the pull request the script opens. The script merges upstream's main into a `sync/upstream-<version>` branch made from
`origin/3.x`, in a worktree of its own, runs the fork's checks at the lowest priority and opens the sync pull request
to `3.x`:

- the layer is intact: every file the table above names is there, and every upstream file it hooks into still has a
  `fork:` comment (`python3 scripts/fork_layer.py check`);
- `bun install --frozen-lockfile`, `bun web/build-plugins.ts`, `bun run typecheck`, `bin/sync-shared --check`;
- `python3 -m unittest discover -s test` (the repo's rules, the installer, herdr-task, the layer's Python tests);
- `bun test` on each of the layer's own test files, one at a time (`python3 scripts/fork_layer.py tests`: every
  `*.test.*` the table names; Bun's module mocks would clash in one run).

Not the whole Bun suite and the build: GitHub's Check workflow runs those, on pull requests to `main` only; on `3.x`
by hand: `gh workflow run check.yml --repo dmasiero/shepherdr --ref 3.x`.

A conflict stops it with exit 3, a failed check with exit 4 (its log: `<worktree's git dir>/sync-upstream.check.log`).
renix's agent then resolves the conflicts (below) or commits a fix in the worktree, and renix runs the script again
with `--continue`, which commits the merge, checks again and opens the pull request. `--continue` always merges the
upstream commit the first run saved (`<worktree's git dir>/sync-upstream`), even if upstream moved on since. A sync
left unfinished is picked up by the next `renix full`.

Upstream comes in by merge, never by rebase or squash: the line is published, and a merge keeps upstream's commits as
they are, so the next sync only sees what is new. A sync pull request is merged with **Create a merge commit**.

By hand, the fallback (the same script, or the plain steps):

```sh
nix develop --command sh scripts/sync-upstream.sh             # or --no-pr: check, then push and open nothing
# after resolving conflicts or fixing the check in the worktree it names:
nix develop --command sh scripts/sync-upstream.sh --continue --dir <worktree>

# without the script:
git fetch upstream
git switch -c sync/upstream-<version> origin/3.x
git merge upstream/main          # conflicts: below
bun install --frozen-lockfile && bun run typecheck && python3 scripts/fork_layer.py check
gh pr create --base 3.x          # merge it with "Create a merge commit"
```

A new piece of the layer needs a row in the table above: the sync checks that its files are there, runs the Bun tests
it names and checks its hooks' `fork:` comments. A Bun the Check workflow moves to: raise the dev shell's with
`nix flake lock --override-input nixpkgs github:NixOS/nixpkgs/<a nixos-unstable rev with it>`.

### Conflicts

A conflict is almost always in one of the layer's hook lines: take upstream's version of the file and put the fork's
change back on top, with its `fork:` comment (the table says what the fork changes in each file and why). Stage the
result and don't commit the merge: the script does, on `--continue`. Where upstream now does what a hook did, drop
the hook and say so in the table. A shared module's copies (`lib/COPIES`): resolve `lib/<file>`, then
`python3 bin/sync-shared` writes the copies.
