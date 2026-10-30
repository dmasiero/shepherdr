# Shepherdr

A private phone, tablet and desktop app for coordinating coding agents on herdr-core.
Spaces have coordinator chats; tasks run Claude Code or Codex in their own worktrees.
Cards, reviews, merges, artifacts, secrets, browser, voice, Autopilot, automations and
panels retain the familiar Shepherdr interface.

This branch contains the 2.1 rewrite. It is not a release or an approved live deployment.
See the [implementation and acceptance record](docs/core/implementation.md) for what is
verified and what remains unverified.

## Start

[Install and start the standalone app](docs/core/start.md). Once installed:

```sh
shepherdr start
shepherdr status
shepherdr stop
```

Open the private Tailscale HTTPS URL reported by status. Core keeps agents alive when
the page closes or the application restarts. Shepherdr binds only to loopback; its
core Unix socket is never exposed to the browser or network.

The permanent home is `~/.shepherdr`. Until an approved cutover, use isolated preview
state and ports. Startup refuses existing legacy state; it never migrates it for you.

## Legacy

Terminal-herdr 2.0.x remains on `v2.0`, including its plugin and original instructions.
2.1 is a standalone core client, with no herdr-app dependency, old SSH workers,
mirrors, tunnels or remote HTTP bridge. It has a [new plugin API](docs/plugins.md).
Existing installed legacy helpers continue to belong to their legacy session.

[Cutover and rollback](docs/core/cutover.md) require separate approval. No version
bump, release, service installation or production state move is part of this build.

## Development

[Development](docs/develop.md) · [Machines](docs/machines.md) · [Plugins](docs/plugins.md)
· [Secrets](docs/secrets.md) · [Tasks](docs/tasks.md) · [Artifacts](docs/artifacts.md).

MIT licensed. Your data and agents run on your machines.
