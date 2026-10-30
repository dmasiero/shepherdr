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
| First run, spaces, sidebar ordering/sections, renames | plugins/places; server/live/places.ts | Partial: real local/second-core homes and scratch spaces created; ordering/sections/first-run parity pending |
| Coordinators and task chats, Claude/Codex, logs/activity, attachments, reactions | plugins/chat; plugins/coordinators; server/live/readers | Partial: both native chats and repeated sends/restart shown; real phone upload reached second-core Claude, native file reaction and human add/remove confirmed; quoted replies shown both ways; native activity rows and recorded read output shown; background child details, large logs and full device parity pending |
| Task IDs, worktrees, briefs, queues, pause/restart/archive/close/delete | plugins/tasks; server/live/engine; server/live/task-ids.ts | Pending |
| Review/PR/checks/ready/merge, conflicts and recovery | server/live/engine | Partial: real local CORE-1 scratch task committed 1222573, native reviewer round 2 reported no findings, exact-commit card approved, squash merge 6e3a817 confirmed. GitHub/conflicts/recovery still pending |
| Questions, permissions, plans, secrets cards and notification answers | server/live/chats.ts; server/push.ts | Pending |
| Remote machines, status, files and reconnect | server/live/machines.ts; server/live/mfs.ts | Partial: same-host second-core Claude task + Codex review + approved merge completed through core only; real SSH/disconnect acceptance pending; old implementation removal pending |
| Artifacts, versions, data, notes, actions, validation | plugins/artifacts; server/live/artifacts.ts | Partial: real second-core artifact 9788e43f published, HTML/data versions and live data-only refresh inspected; button reached native keeper; notes/delete/device parity still pending |
| Scoped secrets and authenticated agent access | server/live/secrets.ts; server/live/secret-access.ts | Partial: second-core masked card saved synthetic key; fresh remote launch used current authenticated helper and returned REMOTE_SECRET_OK without value in chat; CI, env/set/rm and stale-scope acceptance pending |
| Shared browser, takeover and markup | plugins/browser; server/live/browser.ts | Pending |
| Voice, tool/audio bridge | plugins/voice; server/live/voice.ts | Pending |
| Autopilot, usage controls and sandbox | plugins/autopilot; server/live/autopilot*.ts | Pending |
| Automations, recurrence and heartbeat | server/live/automations.ts; server/live/heartbeat.ts | Pending |
| Terminal typing/resize, panels, files/diff/PR | plugins/terminal; plugins/worktree | Partial: raw core attach and phone typing returned TERMINAL_INPUT_OK; phone Files and added-file Diff inspected through second core; resizing/reconnect and actual PR acceptance pending |
| Settings, agent/model/effort policies, private rules | server/live/settings.ts; server/live/models.ts | Partial: scoped role/task/review defaults + private launch rules implemented; phone scoped change inspected; other sections and full acceptance pending |
| Health, alerts, unread/search, keyboard and mobile layouts | plugins/health; plugins/keyboard; src/layout* | Pending |
| User plugins and documented new API | src/kernel.ts; server/plugin-api.ts; docs/plugins.md | Pending; 2.0 API compatibility not required |
| Standalone start/stop/status, installation and optional service | New requirement | Partial: isolated idempotent start/status/stop + crash/core restart exercised; final install/service/cutover pending, no live service enabled |
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

Historical implementation risk (follow-up below): the development Codex launcher used the CLI's
one-invocation hook-trust bypass to exercise generated hooks. That flag also
covers other enabled hooks; trusting generated hooks alone is insufficient to
justify it for a final installation. The follow-up below removes it; native
trust first-run acceptance remains pending.

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

Codex hook trust follow-up: the launch-wide bypass has now been removed. Interactive
Codex keeps native /hooks review; untrusted hooks are skipped by Codex, and a
starting chat explains how to review them in Terminal. First-run native trust
still needs fresh manual acceptance. Read-only Codex reviewers now use the
supported `codex exec --json` event stream (stdin closed), privately captured by
a core-owned holder with a nine-minute limit. Successful report relay requires
both native turn completion and a zero-exit finished holder; failures are told
to the parent separately. No terminal text is used as chat or review results.
Sources: https://learn.chatgpt.com/docs/non-interactive-mode and
https://learn.chatgpt.com/docs/hooks (read 2026-10-29).
The second-core task probe/REMO-1 actually committed 19b9707, completed a fresh
headless Codex review, reached Ready, then merged its scratch change after the
shared-browser merge card was selected and sent. Screenshots:
she301-remote-ready.png and she301-remote-merged.png. This is same-host two-core
acceptance, not a real SSH machine, physical phone or lock-screen push proof.
Scoped trust/reviewer review: no critical/major findings; interrupted-review
notification minor fixed. Full rewrite review and parity acceptance remain open.

Secrets slice in progress: explicit-home vault + existing masked cards and scoped
Settings pages are wired. Agent list/ask/run/env use authenticated core mailbox;
secret responses are encrypted before core docs and journal persistence. Scope
comes only from the active launch's stored machine/space, not request labels.
The agent-side helper runs locally with values in child environment and masks all
nonempty values, including short/split stdout and stderr. Env output requires a
git-ignored plain file. Review found the inherited short-secret masking gap,
fixed with CI regressions; second round had no critical/major, and nonregular env
target refusal minor was fixed. Real two-core secret use and CLI set/rm parity
are still pending; do not mark this row complete.
GitHub core + restart-layout jobs both passed commit 1f2bb1ea (run 40971184563).
Native Codex trust was then accepted through its own hook browser in the shared
Terminal panel, with the generated command/source inspected. All generated
hooks showed active/trusted; a raw phone-input turn produced
CODEX_NATIVE_TRUST_OK in the native transcript and chat. No bypass flag was
present. This verifies the current local native setup path, not remote Codex
setup or a claim that the extra native trust step can be skipped.
The real resumed remote coordinator exposed stale absolute helper paths in its
old conversation. Launches now publish the current SHEPHERDR_COMMAND and replace
earlier routing instructions; a stale helper gets a repair message naming only
its owning launch's current helper, never secret values. This does not change
authority: the server still validates the private active-session grant. Third
Secrets review found no unresolved critical/major. After a fresh start with this routing fix, the actual second-core coordinator
used secret run successfully and returned REMOTE_SECRET_OK. Screenshot:
she301-remote-secret-ok.png. Synthetic value only; actual SSH and complete secret
CLI parity remain pending.

Artifacts slice in progress: native core-only file reads/exports, immutable input
checks (private roots, symlink/hardlink/nonregular refusal), sealed browser
validation, persistent thumbnails, 20 retained versions, data/title-only updates,
comments/notes/actions and keeper routing are implemented. The exact existing
frame and artifact UI are reused. Checker imports no legacy state/SSH transport;
its browser runs in an isolated installation namespace/profile via one core exec
batch, with inherited browser routing removed. Core exec sweeps that batch's
children afterward; no testing browser/service/Tailscale mapping is installed.
Update locks and permanent ID tombstones prevent lost updates and reused links.
Fresh review found hardlink input and revoked-session publication majors; both
fixed with CI regressions. Round two found no unresolved critical/major. Typecheck
passed; real checked-artifact UI acceptance and branch CI remain pending.

Manual offline acceptance: shared preview browser network set offline at
2026-10-29 23:21:33 UTC, then reloaded to chrome-error (old WebSocket/page gone).
Network restored after 23:31:36 UTC, over ten minutes later. The second-core
Claude coordinator's 610-second harmless shell wait completed while the browser
was offline. Reopening its chat showed native TEN_MIN_OFFLINE_OK once, with
correct earlier messages. Screenshot she301-ten-minute-offline.png. This proves
simulated browser network absence + authoritative native-log resync; physical
phone sleep/offline behavior remains unverified. No live agents/services stopped.

Artifact manual acceptance: the real second-core Claude coordinator published
9788e43f from its own file through the authenticated core mailbox. The initial
check refused publication on an agent-browser Unix socket path limit; shortened
installation/session IDs fixed that without changing the shared browser. v2/v3
changed HTML and JSON; v4 changed data only. The existing inline frame retained
its v3 URL while showing ARTIFACT_DATA_TWO, proving the data event updated it
without a page reload. Full screen also showed v4. Send proof reached the native
coordinator as ARTIFACT_ACTION_OK. Phone light/dark inspected; screenshots
she301-artifact-light.png, she301-artifact-data-full.png and
she301-remote-artifact.png. This is two cores on one host, not actual SSH.
Final scoped artifact review round found no critical/major or additional minor
findings. Local typecheck passed; branch CI pending. Full parity remains open.

Chat parity slice: app-owned uploads are checked against their original chat and
forwarded in bounded 2 MiB chunks through core, including binary files up to the
existing 32 MiB upload limit. Each deliberate remote send gets a fresh private
copy; prior links retain access to the original upload, with concurrent history
updates merged. Filenames are normalized before chat-line formatting. Native
attachment, reaction and reply tags use the same pure 2.0 language helpers.
Manual shared-browser phone upload she301-upload-proof.txt reached second-core
Claude, which read REMOTE_UPLOAD_CONTENT_OK and reacted to the file. A tap added
the human side, another removed only that side, and native replies confirmed
both events. Screenshot she301-chat-reactions.png. A manual ordinary HTTP send
with reply identity produced a native QUOTED_REPLY_OK reply; both quote links
appeared in the phone view (she301-chat-quoted-reply.png). This proves the backend
and rendered quotes, not the phone swipe-to-reply gesture.
Manual focus+Enter initially opened a task behind the message; the chat now
consumes its own Enter. Repeating it opened the reaction bar and stayed in the
coordinator. New GitHub layout regression covers that exact navigation conflict.
Scoped review fixed quoted-name, stale-copy and concurrent-copy history minors;
final scoped round found no unresolved critical/major or additional minor findings.
Local typecheck passed; branch CI pending.
Artifacts branch CI passed ca52a13a (run 40974536655): core regressions, legacy
artifact/model regressions and restart layout. Proof hf2s updated to v3.

Native activity slice: common pure turn grouping, step summaries and output
decoding moved to server/activity.ts; legacy adapters retain their public names.
Core activity uses persisted native events and reads only their recorded output
locations through core exec, including on remote machines. Hidden system turns
remain quiet; rows keep chronological order and finished processes have no live
turn. Headless Codex steps link to their own captured native output. Child logs
use native readers with original byte offsets; child output links are isolated
to their owning chat. Shell tails preserve the cut flag even for a very long
single line. Child logs currently have an explicit 4 MiB display limit: full
large-log parity and incremental reading remain pending before readiness.
Manual phone view opened the actual second-core file-read output containing
REMOTE_UPLOAD_CONTENT_OK (she301-native-activity.png). A real 25-second native
background shell appeared in In the background, then disappeared on its native
completion, with BACKGROUND_COMPLETE_OK in chat (she301-native-background.png,
she301-native-background-output.png). No screen parsing or alternate transport.
Scoped review: two rounds, no critical/major, truncation-notice minor fixed;
second round found none remaining. Typecheck passed; branch CI pending.
Chat CI passed 41b6bc45 (run 40975053582), including native chat regressions,
existing core/artifact/model tests, restart layout and the focused-Enter
regression in layout-keyboard.test.ts. All suites ran only on GitHub.

A second harmless background shell printed BACKGROUND_OUTPUT_OK before a
35-second wait. Opening its live job displayed that exact native output in the
existing phone sheet (she301-native-background-output-live.png).

Activity CI 40975708398 passed new core activity tests and all three layout
files, but exposed stale legacy activity fixture doubles missing runtime and
runtimeHook. The fixture now supplies both; branch CI is rerunning.

Worktree panel slice: files, literal relative paths, binary/large-file display,
rename-aware counts, uncommitted additions, unified patches and read-only gh PR
inspection are served by one stateless native script through core machine.exec.
No listener, SSH mirror, worker or legacy filesystem adapter is used. The task
record alone chooses machine/folder/base/branch. Git external diff/textconv and
interactive prompts are disabled; subprocess capture and time are bounded.
File reads reject traversal, outside/ignored symlink targets, nonregular files
and hardlinks. Review exposed a tracked-hardlink bypass in Git diff; the reader
now validates every listed regular content path before Git can read it, with
regressions for tracked hardlinks, redirected paths and literal-tab counts.
Two scoped review rounds: one major and one minor fixed; second round clear.
Manual acceptance: the real second-core coordinator created deferred task
probe/REMO-2; its actual Claude child stayed To do. The coordinator added only
panel-check.txt in that scratch worktree, uncommitted. Existing phone Files
showed PANEL_DIFF_OK and Diff showed its +1 line. Screenshots
she301-core-files-phone.png and she301-core-diff-phone.png. Actual GitHub PR
data/check fallback and complete tablet/desktop/light/dark comparison pending.
Typecheck passed; worktree branch CI pending. Activity follow-up e64e8679 passed
core + legacy activity regressions and all three layout files (run 40975907171).

Final scoped worktree round found no unresolved critical/major or additional
minor findings. Expected reader failures use plain error envelopes. An unreadable
GitHub checks fallback now has an explicit checksError in the existing PR Checks
slot, rather than claiming no checks exist. New helper and layout regressions
cover that access failure; actual GitHub failure UI remains unverified manually.

Task lifecycle safety slice: per-task changes now exclude merge, close, delete,
restart, review/report/ready and message preparation/delivery from racing each
other. A removed task cannot be resumed by a waiting send; reviewer messages
retry their actual reviewer chat after preparation. Shutdown blocks new task
changes, queued-go scheduling and pending-send retries, waits for active task
changes/merges, and leaves undelivered messages queued for restart. An unchanged
local squash-merged branch can be cleaned up without force using the recorded
ready head and merge commit; later work stays protected. GitHub merge commits
are recorded, but syncing the local base after GitHub merge remains pending.
Three scoped review rounds found deletion/delivery, reviewer retry, shutdown
retry and queued-go races; fixes have authored regressions. The final round's
queued-go finding was fixed after its report, without a fourth review round.
Typecheck passed. Manual second-core REMO-2 send after isolated app restart
returned native LIFECYCLE_SEND_OK and remained To do, with its uncommitted panel
marker preserved. Worktree CI 40976525268 passed; lifecycle branch CI pending.

Native main-log reader slice: core machine.exec reads at most 1 MiB of the owning
native file per request, retaining exact byte offsets and incomplete UTF-8 lines.
Whole histories no longer pass through core file.read's 64 MiB whole-file limit.
Inode/shrink, consumed-tail and no-growth modification checks reset replaced
files. Polling tracks each chat independently, with four slots per machine and
rotating fairness; a stalled remote does not block later local polls. Individual
records above 64 MiB have an explicit display limit: a persistent chat notice
names the skipped record and later complete records continue. That is a record
limit, not a whole-history limit. Child activity logs still use their earlier
4 MiB limit, pending the next slice.
Three scoped review rounds fixed unbounded unfinished records, unchanged-suffix
overwrite detection, remote polling blockage and a warning that initially only
entered an internal map; final round found none remaining. Authored CI regressions
cover those cases, UTF-8 boundaries, regular EOF, large sparse files and slot
fairness. Manual second-core native reply NATIVE_READER_OK appeared after an
isolated preview restart (she301-native-reader-phone.png); real >64 MiB native
agent history acceptance remains unverified. Lifecycle CI 40977676240 passed.

Sidebar organization slice: the same shared ordering/section rules now persist
in core-backed product SQLite metadata. Sections, pinned spaces, machine/space
order, moves, renames and emoji use the existing UI. Names never change native
core machine identity or repository paths; machine rename reset shows its native
display name rather than its immutable UUID. Section mutations use own-key maps.
Scoped fresh review found no critical/major/minor findings. Typecheck passed;
authored core regressions cover ordering restoration, scoping, duplicate names,
pinning, native-name reset and invalid inherited object keys. Manual phone UI
created Core proof, moved remote-demo into it and retained the section/move after
isolated server restart; rename to Core evidence succeeded. Screenshot
she301-sidebar-section-phone.png. Drag gesture and full legacy device comparison
remain unverified. Native main-log CI 40978065938 passed.
