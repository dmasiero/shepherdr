# This fork

This repo is a fork of [eliasstravik/shepherdr](https://github.com/eliasstravik/shepherdr) ("upstream"), taken at
v2.0.0. It follows upstream and adds one small layer that upstream chose not to take (Gitea support was closed
upstream before, as herdr-projects #189):

- **Gitea pull requests through `tea`** ([docs/gitea.md](docs/gitea.md)): a space whose remote is on a Gitea server
  gets its pull requests there, as a GitHub one gets them through `gh`: opened, readied, checked, squash-merged at the
  commit here, watched for news, and main watched for going red.
- **A pull request merged already** ([docs/follow-up.md](docs/follow-up.md)): newer work on a merged branch goes in a
  follow-up pull request instead of being left out of main. On GitHub too.
- **The artifact check runs the plugin's own agent-browser**: `shepherdr artifact new/update/check` opened the page
  with a bare `agent-browser` looked up on the server's PATH, which herdr starts without Shepherdr's bin folder, so
  every check failed with `Executable not found in $PATH`. It now runs `browserBin()`, as the tasks' browser does.
- **Voice calls start without a first_message override**: ElevenLabs closed every call right after "Listening"
  (1008, `Override for field 'first_message' is not allowed by config.`), though the agent allowed that override. The
  call now overrides only the prompt; the agent's own first message, "You're through to {{agent}}. Go ahead.", names
  who you called through the `agent` dynamic variable the call already sends (placeholder "your agent").

It is not a GitHub fork: upstream was herdr-projects, renamed, and that network's fork is
[dmasiero/herdr-projects](https://github.com/dmasiero/herdr-projects). This repo holds upstream's history as it is,
with the layer on top.

## The layer

Everything is upstream's except these. `git diff upstream/main main` shows it all.

| File | What |
| --- | --- |
| `server/live/engine/forge.ts` | Which forge a repo is on, and each forge call sent to gh or tea. It re-exports `git.ts`, so the engine, the spaces and the task panel import it instead. |
| `server/live/engine/gitea.ts` | Gitea's twin of each `gh` call in `git.ts`, in the same shapes. |
| `server/live/engine/tea.ts` | tea's logins and one call of Gitea's API through `tea api`. |
| `server/live/engine/follow-up.ts` | The follow-up pull request. |
| `test/engine-gitea.test.ts`, `test/fake-tea.ts` | The tests, with tea faked as `fake-gh.ts` fakes gh. |
| `docs/`, `FORK.md` | These pages. |

Upstream's files change only where they hook in, each marked with a `fork:` comment:

- `server/live/engine/engine.ts`: imports `forge.ts` as `G`; `onGitHub` and the texts sent to agents and
  coordinators go through `forgeWords` (Gitea and tea, not GitHub and gh, for a Gitea repo); `openPrNow` and
  `mergeOnGitHub` open a follow-up for a merged pull request with work since.
- `server/live/places.ts`: a space's forge repo from `forge.ts`.
- `server/live/engine/engine.ts` (`add`): a new task's Settings block goes through `forgeWords` (its Merge line says
  Gitea's checks in a Gitea space).
- `server/live/source.ts`: `shepherdr space add` and `space list` name the space's forge (`forgeName`).
- `server/live/source.ts`: the artifact checker runs `browserBin()` (tested in `test/source.test.ts`).
- `server/live/voice.ts`: the voice agent's first message and the call's override (tested in `test/voice-call.test.ts`).
- `server/live/args.ts`: the help of `pr`, `checks` and `merge` says GitHub or Gitea.
- `server/live/worktree.ts`: the task panel's pull request asks Gitea for a Gitea repo.
- `skill/shepherdr-agent/SKILL.md`, `skill/shepherdr-coordinator/SKILL.md`: "GitHub (or Gitea)".

## Syncing with upstream

```sh
git fetch upstream --tags
git checkout -b sync/upstream-<version> main
git merge upstream/main          # or the release tag
bun run typecheck && bun test test/engine-gitea.test.ts test/engine-merge.test.ts
```

Upstream comes in by merge, never by rebase or squash: `main` is published, and a merge keeps upstream's commits as
they are, so the next sync only sees what is new. A sync pull request is merged with **Create a merge commit**. A
conflict is almost always in one of the hook lines above: keep upstream's change and put the hook back. If upstream
renames a `git.ts` function the engine calls, `forge.ts` must pass on the new name (`bun run typecheck` says so).

renix builds this fork (`pkgs/shepherdr.nix`, listed in `pkgs/forks.nix`): after a sync is merged, point it at the
new commit and its hashes.
