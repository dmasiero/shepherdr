# Settings: Everywhere and a space's own

Every setting has a value for **Everywhere**, the default. A setting that makes sense per space can also be set for
one **space**: the space's own wins there, and a setting the space doesn't set is inherited from Everywhere. Reset
drops the space's own, and it inherits again. A few settings are one for every space, or one per machine.

## Where you set them

- **Settings, the level switch.** At the top of each page a space can set its own of (Agents, Tasks, Autopilot,
  Notify, Secrets): *Applies to: Everywhere ⌄*. The picker lists Everywhere, then every space by machine (a Find box
  once there are many). Pages that are one for every space (Machines, Window, Web) say so instead.
- **A space's menu › Space settings…** opens Settings on that space, in the window and on the web.
- **Under each row, in a space:** *Inherited from Everywhere*, or *Set for this space · Reset*. On Everywhere, a row
  that some spaces set their own of says *2 spaces set their own*, which lists them (each opens that space's).
- **The header's Autopilot switch** turns Autopilot on or off in its space; *Write a heartbeat* opens that space's
  Autopilot page.

## The audit

| Page | Setting | Level | Why |
|---|---|---|---|
| Agents | Assistant (CLI, model, effort, fast, permissions) | Everywhere, space | A repo may want a stronger model or another CLI |
| Agents | Workers | Everywhere, space | The same: what a task in this space runs on |
| Agents | Reviewer | Everywhere, space | The same |
| Agents | Backup agent | Everywhere, space | A space whose work shouldn't move to the other CLI |
| Agents | Reactions (every agent reacts with an emoji; on) | Everywhere, space | A space may want a plainer chat |
| Agents | Lessons (on; the lessons you kept, Edit and Retire) | Everywhere, space | A space may not want agents learning there; a space's lessons are about its own work |
| Agents | Instructions (assistant.md, worker.md, reviewer.md) | Everywhere only | Repo rules belong in the repo's AGENTS.md or CLAUDE.md, which every agent there reads |
| Tasks | Merge, Review, Must fix, Proof | Everywhere, space | How much care a repo needs differs |
| Tasks | Tasks at once | Everywhere, space | It counts per folder already |
| Tasks | Archive Done after | Everywhere, space | Some repos keep done work in view longer |
| Tasks | Worktrees | Everywhere, space | A folder that isn't a repo, or one that can't take worktrees |
| Tasks | Base branch | Space only | A branch only means something in one repo |
| Tasks | Branch names (a pattern: `{n}`, `{key}`, `{slug}`; empty: `task/{n}-{slug}`; a task's own `--branch` wins) | Everywhere, space | A team may name branches after its tickets |
| Tasks | Run automations | Everywhere, space | Pause one repo's automations |
| Tasks | When a task starts / finishes | Everywhere, space | Setup and cleanup steps are a repo's |
| Autopilot | Heartbeat, Schedule, Events | Everywhere, space | Each space works toward its own goal, at its own pace |
| Autopilot | On or off | Space only | The header's switch: Everywhere never turns a space on |
| Notify | All / Needs me / Off | Everywhere, space | A busy space can be quiet |
| Secrets | A secret | Everywhere, machine, space | A key for one repo, or one machine's own |
| Secrets | Kept on | All machines | One vault every machine's agents and voice calls use; follows Serve from unless picked |
| Machines | When new tasks wait (memory, CPU, disk), low priority, memory cap per worker | All machines, machine | About a machine's hardware, not a space's work |
| Machines | Home Assistant | Machine only | One per machine |
| Window | Tabs, sidebar, counts, filters, subagents, Assistant in new spaces | Everywhere only | How the screen looks; the last is about spaces not made yet |
| Window | Add-ons | Everywhere only | Which mods run: the window's, for every space |
| Web | Serve from, link | Everywhere only | One web app for every machine |

**No Machine level for the rest.** A space already lives on one machine, so a space's own covers "this machine's
repos" without a third layer, and one less layer keeps "where does this value come from" one line long. What a machine
genuinely differs in (its hardware, its home space, a key only it has) is already on Machines and Secrets. Agent and
task values a machine set before (the old machine scope) still apply there until Reset, and say so on Machines.

## Where they're kept, and how they travel

- `~/.config/shepherdr/settings.json`: `everywhere` and `spaces[<space id>]` (another machine's space as `<machine>/<id>`), each
  with `coordinator`, `worker`, `reviewer`, `backup`, `tasks`, `automations`, `agents` (`{ reactions }`) and
  `autopilot` (`{ every, events, heartbeat }`). The window pushes each machine its share (Everywhere's and its spaces' by their
  ids there), and when the web app is served from another machine its service keeps the file in step with that host
  (`service/sync.ts`). So a space on any machine, and the web on the Mac mini, see the same values. On a machine
  still on an older Shepherdr the file is `~/.herdr/shepherdr.json`; pushes and syncs find it there.
- `tasks.worktree_root` (in `everywhere`, a machine's or a space's `tasks`; no row in the window yet): the folder new
  task worktrees go in, e.g. a bigger disk (`~` allowed). Unset: `~/.local/share/shepherdr/worktrees`. A task keeps
  the worktree it has.
- Secrets live in one vault, `~/.local/share/shepherdr/secrets/vault.json` on the machine that keeps them (Secrets › Kept on). Which one:
  herdr-core document `shepherdr.secrets` = `{ id, at, by }` on every machine, handed on by each service as
  `shepherdr.host` is (`core/secrets.js`). `herdr-secret` on any other machine passes `set`, `rm` and `names` there
  over herdr-core (the value on stdin, scopes renamed into that machine's words); that machine's service answers every
  agent's request even with no window open, and voice calls read the ElevenLabs key from there into memory only.
  `shepherdr secrets move-to <machine>` moves the vault (a backup on both sides; `move-to here --restore` on the old
  one rolls back when the other is gone). By default the secrets follow Serve from (Kept on says "Same as Serve from:
  <machine>"): with no machine picked, each service names where the secrets are now (the machine whose vault has
  some, else the one serving the web app: `autoKeeper`, a record with `auto: true`) and hands it on, so voice calls
  and agents work with no setup; then the machine serving the web app moves them to itself with `move-to` (backup,
  verified copy, rollback), and does so again when Serve from moves. Picking another machine in Kept on stops the
  following; picking the Serve from machine starts it again. Voice calls with no record yet ask each linked machine
  for the key. No record and nothing to decide yet: the machine without `~/.local/share/shepherdr/secrets/remote` keeps them.
- Notify is in the shared document (`notify`), kept in step the same way.
- herdr-task reads the effective value: `settings_for()` for agents and tasks (the Settings block every brief ends
  with names who set each line), `autopilot.resolve()` for Autopilot (`herdr-task autopilot show` lists which parts are
  the space's own). Autopilot's schedule and events from before Settings kept them (`~/.local/share/shepherdr/tasks/.autopilot.json`
  `everywhere`) and its heartbeat file (`~/.config/herdr-core/autopilot/everywhere.md`) are what Everywhere inherits
  until it's set.

## Reactions

Agents › Reactions, on by default: every agent reacts to some of your messages with one emoji, as a person would:
Assistants, task workers, automation runs and plain agent tabs, on every machine. It picks the most specific,
delightful or funny one that fits, not a generic 👍 or 👀 by default (🚀 for a launch, 🔥 for a great result, 🐛 for a
bug report, 🧹 for a cleanup ask, 🫡 for a direct order, 🤌 for a nice detail, 🍿 for drama). Tasteful: most messages
get none, never more than one, and never instead of an answer you need. Off, none reacts. The reactions show on your messages in every chat, the
Assistant's, a task's and an agent tab's, in the window and on the web (`core/chat-log.js`).

- **Kept as** `agents.reactions` at each level. SHEP-42 kept it as the Assistant's, `assistant.reactions`: it still
  applies where a level has no `agents.reactions` (herdr-task, the window's chain), and the window and the web app
  move it there when they read the file (`upgradeReactions` in `core/settings.js`), so their next change writes it.
- **How it's told.** The chat's SessionStart hook (`mods/chat/session-note.sh`) asks `herdr-task _session-note` for
  every agent's extra words: an Assistant's settings block (below) ends with them, any other agent gets just them
  (`herdr_task/reactions.py`): the when-and-how paragraph (GUIDE) when on, "never react" when off, by its space (its
  terminal's space or task-space label, else the space whose folder holds its folder, else Everywhere's). It runs at
  every start, resume and compaction, for Claude Code and Codex, and labels the terminal `herdr.reactions=on|off`. The
  role instructions (`assistant.md`, `worker.md`, `reviewer.md`) don't carry it: they are your words to edit, and the
  hook is the one start path that knows the setting now.
- **Changed mid-session.** A `<herdr-setting name="reactions" value scope>` line: an Assistant's comes with its other
  changed settings (below); every other live agent its hook taught gets it alone from herdr-task's news pass
  (`reactions_pass`), once, ending "carry on with what you were doing; if nothing, reply only `<hc no-reply/>`", so a
  worker mid-task keeps working. One started before this isn't told until it starts again.
- **Reviewers** run as their worker's own helper agents (an hc child, shown as a subagent in its chat): their hook
  teaches them too, but your messages rarely reach them, so they seldom react.
- **A reaction only.** A reply of a `<hc react … />` line and `<hc no-reply/>` shows just the reaction on your
  message.

<!-- fork: SHEP-67: Lessons is the fork's (FORK.md, Agents that learn) -->
## Lessons

Agents › Lessons, on by default: when you step into a task (a correction, a go-ahead, a standing rule, an answer it had
to ask for), its agent drafts up to 3 short lessons at ready; nothing reaches a later brief until you keep one
(`herdr_task/lessons.py`). At the foot of the Agents page, at the page's level:

- **The switch** (`lessons.on`). Off, workers draft none, no lesson cards are raised, and briefs and the Assistant's
  settings block carry no lessons at all. The kept ones stay saved (`lessons.kept` beside it) and come back when it's
  on again. A space's own follows Everywhere's until it sets its own; setting what it would follow anyway unsets it.
- **The budget line**: *In briefs: 6 of 12 · 640 of 1,500 characters*, how much of a brief's lesson budget the kept
  lessons use at this level (a space: its own first, then Everywhere's). Off, it says so instead.
- **Each kept lesson**: its words, the tasks it came from (chips that open the task while the app still has it), when
  it was kept, how often it went into a brief (*seen*), *edited* if your words replaced the draft's. One a brief
  wouldn't get says why: over the budget, or (Everywhere's, in a space) the space keeps one that says the same.
  **Edit** takes new words, checked as a draft is (no secret, password or name); **Retire** asks first, then turns it
  off: in no brief again and never drafted again, still saved (counted under the list). Both run
  `herdr-task lessons edit|retire <id>` (the web through `service/actions.ts`, the window through
  `mods/shepherdr-settings/lessons-section.js`), which changes it where it's kept, even under a space's full id.
- **A space's page** lists its own, then folds Everywhere's under *Inherited from Everywhere (n)*: those reach every
  space, so Edit or Retire there changes them everywhere.
- **The web's Accept card** shows an *n lessons* chip under the summary when the task has drafts waiting (`herdr-task
  show`'s `lessons_waiting`, none while off). It opens them with Keep, Edit and Drop, so you can answer while you're
  already looking at the task; the Assistant's question card stays the fallback and never asks about one you answered.

The words and the budget are `core/settings.js`'s (`LESSONS`, `lessonsView`, the same count as `lessons.py`'s
`within_budget`), so the window and the web app say the same.

## What the Assistant is told

A space's Assistant knows the settings that shape how it makes and runs tasks, resolved for its space (Everywhere's,
then the space's own), without guessing (`herdr_task/assistant_settings.py`):

- **At every start, resume, compaction and handoff** the chat's SessionStart hook (`mods/chat/session-note.sh`) asks
  `herdr-task _session-note` for a "Your settings" block, like the Settings block a worker's brief ends with: Review
  (rounds, must fix, reviewer), Merge, Proof, Task agent, Base branch, Worktrees, Tasks at once, Task notes (start and
  finish notes set or not), Autopilot (on or off, schedule, direction) and Reactions, one line each. A line that differs
  from Herdr's default says who set it (*set for this space*, *your setting everywhere*). The terminal is labelled
  `herdr.settings` with a short hash of each line.
- **Changed while it runs** (in the window or on the web, Everywhere or the space): herdr-task's news pass (on a
  settings change, and every minute for Autopilot's switch) sends each live Assistant whose lines differ one message,
  a line per changed setting: `<herdr-setting name="review" value="on" scope="everywhere|space">Review is now on, …
  Tasks you add from now on get it; running ones keep their brief.</herdr-setting>`, the last ending "reply only
  `<hc no-reply/>`". A save that changes nothing for its space says nothing. One started before this (no label) gets the
  whole block once it has had a turn. Busy with the person: next pass.
- **The chat hides them**, as every Herdr tag (`core/chat-log.js`), and the `<hc no-reply/>` after: a settings change
  already shows where it was made, so a news row would only repeat it.
- **Other agents get only Reactions** (above): a worker's brief's Settings block is fixed when it starts.

