# Frozen launch-readiness checklist — SHE-301

Frozen against the agreed 2.1 plan and Elias's finite-readiness instruction, 2026-10-30.
No new product features, scope reduction, merge, deployment, state migration, release or version change.
The implementation/parity baseline is implementation.md; historical proof remains artifact hf2s.
Outcome words: PASS = listed evidence meets that check; FAIL = observed defect; UNVERIFIED = evidence absent.
A fixture pass is identified as a fixture and never promoted to native/device/external proof.

| Gate | Proof required to close | Current outcome / finite remaining action |
| --- | --- | --- |
| Scope and parity freeze | Every agreed feature mapped to implementation and existing evidence; no deleted capabilities | PASS for scope inventory in implementation.md; complete visual/device parity UNVERIFIED |
| Post-review changes | Fresh independent review of ed75b57e..final code; resolve critical/major and re-review fixes | UNVERIFIED; new independent reviewer assigned, at most three rounds |
| Exact final commit CI | Full Check on exact final code SHA, all shards/types/build green; re-run after any code correction | UNVERIFIED; dispatch after acceptance/review fixes, explicit human authorization |
| Recurrence | Recurring time rule fires twice, restart does not duplicate, pause stops, resume advances, timezone/DST/bounded catch-up cases | UNVERIFIED for complete matrix; finite isolated native recurrence plus CI fixture cases |
| Events | added/ready/failed/needs-you/merged/stalled and filters, no replay/recursive automation loop; heartbeat health/main-red | PARTIAL historical native failure/stall/main-red; remaining matrix UNVERIFIED, close through named CI fixtures plus bounded isolated native run |
| Provider retry/fallback | Native failure classified; documented retries/one-shot takeover preserve checkout; auth/permissions/containment exclusions | CI fixture coverage PASS historically; real native fallback UNVERIFIED. One owned isolated invalid-credential failure attempt; no live agent/provider settings touched |
| GitHub checks/merge | Existing authorized identity reads checks on exact task head; product merge confirms exact head and cleans safely | UNVERIFIED: configured GraphQL statusCheckRollup refusal. One permissions check on owned scratch repo; use only suitable already-authorized credentials, otherwise stop and report exact needed grant |
| Install/manual/service lifecycle | Isolated home and pinned core; idempotent start/status/stop; transient service crash recovery and manual control, children survive | Manual startup PASS historically; isolated service UNVERIFIED. One transient user service, never enable/install a live service |
| Physical phone alerts | Private preview; enroll this device, lock it, receive and answer harmless permission/question once; same card settled | UNVERIFIED; guided Elias interaction required |
| Phone offline/reconnect | Phone offline ten minutes during harmless work; reconnect gives authoritative state/no duplicate answer/action | Simulated browser PASS historically; physical phone UNVERIFIED; one guided run |
| Real voice | Isolated scoped key supplied through masked UI by Elias; mic/listen/speak/interrupt/tool result/end, no recording/value exposure | UNVERIFIED: no isolated key; never inspect/copy live credentials |
| External vm-ssa | Existing configured authenticated core-only connection; remote lifecycle/mailbox/files/resync | UNVERIFIED, SKIPPED per Elias: no configured address/working trusted connection. No retry unless usable details arrive; same-host SSH is distinct |
| macOS | Actual supported launcher/service and native agents on macOS | UNVERIFIED: no accessible Mac in authorized target scope. Documented only; not a pass |
| Cutover/rollback | Reviewed exact source/checks, protected v2.0, writer inventory, verified stopped-state backup, legacy relocation/config, fresh new home; rollback retains both | Runbook prepared in cutover.md; execution UNVERIFIED and prohibited until separate approval |

## Launch impact and stopping rule

No-go while review majors, final full CI, or required human/device/voice checks are unresolved. External vm-ssa
is an explicitly skippable limitation, not evidence that remote deployment is verified. macOS remains unverified
and must not be advertised as runtime-validated. No launch gap is silently accepted by this checklist.

Each software acceptance gets one bounded attempt plus fixes for concrete failures; no repeated auth/setup guesses.
CI fixtures cover deterministic timing/error cases; actual harmless runs cover the feasible native/lifecycle path.
At the end report a single go/no-go, exact code/review/CI SHAs, every accepted/unresolved gap and cutover order.
A missing credential/device action becomes one precise human choice with a recommendation, not more feature work.

## Guided human session (prepared; not yet run)

Use an isolated private preview only. Existing live 2.0 URL/state stays unchanged. A new private route requires the
operator's explicit action/authorization; development must not replace existing Serve mappings. Session order:
1. Open preview on phone; confirm home/space/task/terminal/artifact navigation in light/dark and intended orientation.
2. Add this device in Notifications; lock phone. Receive one harmless approval, answer, confirm same card settles once.
3. Put phone offline for ten minutes while one harmless task completes; return and confirm final state/transcript once.
4. For voice only, Elias supplies a separately authorized key through the preview's masked Secrets UI (not chat/files).
   Start a short call, speak/listen/interrupt, ask a harmless status question, end. Remove only the isolated test key.
Record device/browser, timestamps, outcomes and exact missing steps; do not call desktop emulation a phone pass.

## Finite phase evidence log

- Fresh independent Codex review round 1 covered ed75b57e..88937344: no critical/major; one minor audit wording
  corrected to name the unchanged keyboard entrypoint, excluding its changed search submodule. Round 2 reviewed
  new matrix/tests through a7852072: no critical/major. No local checks were run by the reviewer.
- GitHub existing configured identity: owned repository check-runs REST call returns HTTP 403 “Resource not
  accessible by personal access token”. No credential inspected/copied or alternate identity injected. Elias was
  asked only to enable Checks/Commit statuses read for the existing login, or retain no-go for that gate.
- Native owned provider attempt: only the new transient application's Claude environment uses an empty private
  config and deliberately invalid synthetic API credential. Claude emitted native authentication_failed/401 and
  OSC blocked; the UI showed the real error. Before correction no provider retry/takeover was recorded because
  the generic blocked guard excluded even an ended provider failure. Correction permits recovery only with a
  caught-up ended native error, retaining permission/question/secret/background/identity gates. After restart,
  the product performed exactly one Claude→Codex takeover for Signed out; native Codex replied
  OWNED_PROVIDER_FALLBACK_OK and task LAUN-1 finished Done. This is an actual native failure with an intentionally
  invalid isolated credential, not a real account outage or failure manufactured in a live agent. Backoff timing
  and exclusion cases remain deterministic CI fixtures.
- Transient Linux service she301-launch-accept: never installed/enabled. Own main process killed once with
  SIGKILL; systemd restarted it (NRestarts=1), private core ID and coordinator PID/launch unchanged. Idempotent
  manual start returned the service PID. Only this owned service/core/home/port were involved.
