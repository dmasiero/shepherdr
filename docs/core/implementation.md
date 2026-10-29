# Shepherdr 2.1 delivery record

This is an implementation checklist, not a release or a claim of parity. Work is on
`work/301-build-shepherdr-2-1-on-core`; do not merge it into live-followed main until
the complete acceptance run and approved cutover.

## Baseline and safety

- Verified origin/main: `ebb17d585c82906b788a8473237921802920b5c5` (SHE-295).
- Preserved the same commit as origin/v2.0 without overwriting any ref.
- The existing supervisor (`scripts/supervise.ts`) rebuilds on checkout changes.
  Main, installed helpers, live services, Tailscale mappings and live state stay untouched.
- Downloaded official core 0.1.14 into `/tmp/she-301-bin`, not the installed PATH.
  Probes use separate `HC_SESSION`, XDG config, state and runtime directories.
- Core source inspected: herdrdev/herdr-core, commit
  `298d9c9094ce36c2c80c8bd917032458d5f440f1`. Protocol generation 1.
- Temporary core sessions are not security boundaries. Core socket access grants
  account-wide command/file access. Never publish that socket or accept raw RPC from a browser.

## Build order and acceptance gates

- [ ] Core connection: pinned schema, framed RPC/attach, bounds, reconnect/resnapshot,
  mailbox authentication, remote document/file exchange, both agents' real status sources.
- [ ] Coordinator/chat: standalone launch, first run, spaces, Claude Code/Codex,
  native transcript readers, messages and persisted reconnect.
- [ ] Tasks/review/merge: core children, worktrees, workflow labels, queues,
  review, permission cards, merge safeguards and proof.
- [ ] Remote machines: core-only transport; disconnect/reconnect, remote tasks,
  files, credentials, mailbox response and recovery.
- [ ] Remaining parity: every feature below with real acceptance evidence.
- [ ] Full parity verification, fresh review, branch CI, complete proof artifact.
- [ ] Cutover approval (only after everything above is reviewable).
- [ ] Separate release approval; no version bump, tag or publication during build.

## Core observations (manual isolated probes, 2026-10-29)

These are API checks with harmless sleep processes, not product acceptance or
local test suites. The second machine is another isolated core on this host using
the documented `machine.add via` connection; actual remote SSH is not yet proven.

| Requirement | Evidence / remaining work |
| --- | --- |
| API compatibility | Binary reports 0.1.14; hello generation 1 and rpc.discover checked by new client |
| Documents | CAS set/get worked; event includes name/version; value must be fetched |
| Combined remote mailbox | Set/get through `on: probe`; local stream reported `machine: probe` |
| Remote files | `file.read on: probe` returned exact first two lines of scratch connection helper |
| Child outlives parent | Local t4 survived killing t3; remote probe/t1 survived killing local t6 |
| Cross-machine parent | Use `caller` with `on`, not explicit `parent`: explicit parent resolves on destination; returned child parent was local t6 |
| Core restart | Holder adopted live t4 after server.restart followed by explicit core start |
| Restart API | server.restart prepares/stops; CLI/server manager must start the replacement; do not wait for RPC to spawn it |
| Attach | First paint received via framed terminal.attach; cols/rows are required |
| Event framing | Event channel is a newline-delimited byte stream; multiple messages can share a frame |
| Event resync | New CoreSession observed disconnect, then epoch 2 with seq reset 29→1 and a second authoritative resync after isolated CLI restart |
| Agent status | Claude Code 2.1.312 and Codex 0.163.0 emitted SessionStart/UserPromptSubmit/Stop with transcript paths in real isolated runs. Both interactive CLIs also emitted native OSC 7501 (`reported: true`); hooks/logs and explicit core status are the sources |
| Agent permissions | Both real interactive CLIs emitted PermissionRequest to a per-launch hook for a harmless scratch-file request. Claude hook denial visibly stopped it. Codex was stopped after its hook event; final denial completion still needs proof |
| Mailbox authorization | AES-GCM request/reply with per-session grants and durable claims implemented. Actual roundtrip through second core succeeded; unauthorized action refused without dispatch. Product secret/card/merge dispatch not yet connected |

The Codex integration uses the documented per-invocation inline hook configuration
and explicit trust of Shepherdr-generated hooks, without changing the user's
hook files. Reference: [official hooks documentation](https://learn.chatgpt.com/docs/hooks).
Headless `codex exec` uses approval `never`, so it is not evidence of interactive
permission handling.

Early core-slice review: three read-only fresh-eyes rounds; four major findings
fixed in round one, one additional major fixed in round two; round three found
no critical/major. Minor cancellation, idempotent start and uncertain-dispatch
reporting findings also fixed. Regression tests were written, not run locally;
`bun run typecheck` passed. This is not the final review of the complete rewrite.

## Feature parity matrix

Baseline references are source locations on the verified legacy commit. Every row
is pending until it has current-branch runtime evidence, including matching
phone/tablet/desktop light/dark screenshots for visible features. Demo data is
not evidence of a working feature.

| Feature | Legacy baseline | 2.1 acceptance evidence |
| --- | --- | --- |
| First run, spaces, sidebar ordering/sections, renames | plugins/places; server/live/places.ts | Pending |
| Coordinators and task chats, Claude/Codex, logs/activity, attachments, reactions | plugins/chat; plugins/coordinators; server/live/readers | Pending |
| Task IDs, worktrees, briefs, queues, pause/restart/archive/close/delete | plugins/tasks; server/live/engine; server/live/task-ids.ts | Pending |
| Review/PR/checks/ready/merge, conflicts and recovery | server/live/engine | Partial: real local CORE-1 scratch task committed 1222573, native reviewer round 2 reported no findings, exact-commit card approved, squash merge 6e3a817 confirmed. GitHub/conflicts/recovery still pending |
| Questions, permissions, plans, secrets cards and notification answers | server/live/chats.ts; server/push.ts | Pending |
| Remote machines, status, files and reconnect | server/live/machines.ts; server/live/mfs.ts | Pending; legacy workers/mirror/tunnels must disappear |
| Artifacts, versions, data, notes, actions, validation | plugins/artifacts; server/live/artifacts.ts | Pending |
| Scoped secrets and authenticated agent access | server/live/secrets.ts; server/live/secret-access.ts | Pending |
| Shared browser, takeover and markup | plugins/browser; server/live/browser.ts | Pending |
| Voice, tool/audio bridge | plugins/voice; server/live/voice.ts | Pending |
| Autopilot, usage controls and sandbox | plugins/autopilot; server/live/autopilot*.ts | Pending |
| Automations, recurrence and heartbeat | server/live/automations.ts; server/live/heartbeat.ts | Pending |
| Terminal typing/resize, panels, files/diff/PR | plugins/terminal; plugins/worktree | Pending |
| Settings, agent/model/effort policies, private rules | server/live/settings.ts; server/live/models.ts | Pending |
| Health, alerts, unread/search, keyboard and mobile layouts | plugins/health; plugins/keyboard; src/layout* | Pending |
| User plugins and documented new API | src/kernel.ts; server/plugin-api.ts; docs/plugins.md | Pending; 2.0 API compatibility not required |
| Standalone start/stop/status, installation and optional service | New requirement | Pending; no service enabled during testing |
| Browser WebSocket resync, bounded output, duplicate-safe commands | server/app.ts; src | Pending |

## Final acceptance and deployment boundary

Coordinator evidence: Claude Code and Codex each answered two messages through the
unchanged app. In the isolated preview, Codex t18/PID 983333 remained live across
server and core restart during a 30-second tool call, then returned
`SURVIVED_RESTART`. Standalone repeated start retained the same server PID; stop
left core and agents alive. No live state or mappings changed.

Not yet verified: full task lifecycle for both agents; a real remote worktree/task through
permission notification, artifact and merge; ten
minutes offline; every parity row; identical UX across device sizes.

At approved cutover only: stop all legacy writers; make and verify a complete
backup (including SQLite WALs); relocate legacy home to `~/.shepherdr-legacy`;
pin legacy launch code to v2.0 and audit every path before restart; initialise
fresh 2.1 at `~/.shepherdr`; never allow shared writes. Rollback stops 2.1 writers,
preserves new state separately and restores verified legacy launch/home settings.
The final runbook must specify exact installed service/config paths after their
read-only inventory; this checklist does not authorize operational changes.

## Current integration work

Standalone lifecycle, native coordinator chat, durable command receipts, permission
mailbox dispatch and an initial task/worktree/review/merge implementation are in
the integration branch. These are not completed acceptance gates. Mailbox requests
run concurrently so a human permission wait does not block status; answer writes
remain serialized and retain responses for the current request queue. Helpers
reconnect with the same authenticated request identity. New regression coverage
runs only in branch CI. Local verification remains typecheck and manual inspection.

Manual task evidence: the unchanged app's coordinator created CORE-1 as a real
Codex core child in a separate scratch repository and worktree. A native
PermissionRequest became a card; answering Allow once let Git commit succeed.
This is desktop/shared-browser evidence, not lock-screen push evidence. The
existing Terminal panel now displays the real raw core attach over a per-viewer
WebSocket with bounded queues, acknowledgements and no input replay. Further
typing/reconnect acceptance is pending.

Second scoped review found five major lifecycle defects in the new integration:
answer delivery could be lost, stale-session cards could answer replacements,
fresh merge cards could retain old approval, terminal confirmation could overwrite
hooks, and hook EOF could block transcript polling. Fixes and regression tests
are being checked in branch CI; this is still not final rewrite review. Manual
restart also exposed replayed PermissionRequest hooks resurrecting answered cards;
permission ownership now belongs only to authenticated mailbox dispatch.

Proof artifact `hf2s` (SHE-301: Proof) records the actual coordinator chats,
restart response, ready card, scratch merge and Terminal panel. It explicitly
lists unverified capabilities. Three scoped integration review rounds found
five initial majors, two additional session/expiry majors and one visibility
major; all were fixed with regression coverage. The final complete-rewrite
review remains pending. Manual acceptance then exposed premature reviewer
commentary forwarding: relays now require a successful native turn-end marker
and retain the reviewed commit. An aborted turn is not a completed review.

Remote provisioning is implemented through core machine.exec only. Helpers are
immutable, content-versioned files in a private per-installation agent runtime
under the destination user's .local/share/shepherdr-agents; credentials are
created with exclusive mode-0600 writes, never file.write's default permissions.
Agent-side hc connect speaks the pinned framed API to its own core; no app
listener, SSH bridge or per-machine worker is installed. Both binary version
and the helper's actual connected core identity are checked before launch.
A real Claude coordinator on the isolated second core returned
REMOTE_CORE_CLAUDE_OK through its own native transcript. This is same-host
transport evidence, not real SSH-machine acceptance.

Remote task IDs retain their machine-local prefix/number, qualified by the core
machine name in the combined app (e.g. probe/CORE-1), avoiding cross-machine
collisions. Bare local IDs resolve only within the authenticated caller's space.
Workflow remains separate from an unreachable agent's machine status.

Open implementation risk: the development Codex launcher currently uses the CLI's
one-invocation hook-trust bypass to exercise generated hooks. That flag also
covers other enabled hooks; trusting generated hooks alone is insufficient to
justify it for a final installation. Preserve native hook trust or vet every
loaded source before the final acceptance/release. Do not call this resolved.

Scoped task/agent Settings are now stored in the isolated core SQLite store,
with Everywhere → stable machine → space inheritance and explicit empty private
instruction overrides. Existing Settings and restart-sheet components are reused.
Role defaults, model/effort picks, review policy and private launch snapshots are
connected; backup, capacity, archive, browser, notification and other catalog
sections remain pending. Native Codex model discovery travels through core exec.
The pure legacy model catalog/parsers are shared without importing legacy state.
Manual phone-width inspection changed a scratch space's task Agent to Codex and
showed its scoped reset/inheritance controls; screenshot she301-settings-phone.png.
Settings slice review: three rounds, cross-CLI model and resumed/parent launch
choices fixed, checks-only merges fail closed without GitHub checks, and atomic
save notifications fixed; final round found no unresolved critical/major issue.
No local suites ran. Branch CI remains the check authority.
