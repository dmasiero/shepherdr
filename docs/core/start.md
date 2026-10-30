# Standalone Shepherdr on core

Implementation documentation for the isolated rewrite branch. Full parity and
release acceptance are still pending: see [the delivery record](implementation.md).
Do not deploy this branch over a running legacy installation.

## Requirements and installation

- Bun 1.4.2 (the CI-pinned version), Git, and herdr-core **0.1.14**, generation 1.
- Claude Code or Codex installed and signed in on each machine that runs agents.
- Tailscale on the server and the devices opening the app.

Build the reviewed source on a build machine or CI, not the shared agent VM:

```sh
bun install --frozen-lockfile
bun run build
```

Put this checkout's `bin` directory on PATH. The application is standalone:
there is no terminal-herdr plugin installation and no herdr-app dependency.
Core has its own `shepherdr` session, keeping these agents separate from a
desktop client's default core session. The server checks hello and the live
schema against its pinned core release before accepting work.

## Manual control

```sh
shepherdr start
shepherdr status
shepherdr stop
```

Start is idempotent. It returns the running PID, core connection status, and
any existing private Tailscale Serve URL for that port. Stop stops only the
application: core and its agent terminals keep running. A stopped application
does not receive new phone requests until restarted.

The permanent home is `~/.shepherdr`. Startup refuses an unmarked, nonempty
home, so it cannot silently reuse legacy state. `status` is read-only. Build
previews must explicitly choose separate state, port and core session:

```sh
shepherdr start --home /tmp/shepherdr-preview --port 17887 \
  --core-session shepherdr-preview --core-bin /path/to/pinned/hc --no-plugin-updates
shepherdr status --home /tmp/shepherdr-preview
shepherdr stop --home /tmp/shepherdr-preview
```

`--core-socket` can select an endpoint inside a private directory. Keep custom
socket paths short. Never share the core socket over the network.

`--no-plugin-updates` is for Vite previews on a machine where build checks are prohibited. It disables the plugin
watcher and switches. Ordinary startup watches the selected home's plugins and off list, builds from a fixed copy
of the started application, and swaps plugin runtime/assets without restarting agents. It never follows main or
another checkout ref. Keep the installed source/dependencies available while it runs. See [Plugins](../plugins.md).

## Private URL

The server binds only to `127.0.0.1`. Startup discovers existing Serve mappings;
it never installs or changes one, and never enables Funnel. After deployment
approval, the operator can inspect `tailscale serve status` and add a private
path without replacing existing mappings:

```sh
tailscale serve status
tailscale serve --bg --set-path /shepherdr 7787
shepherdr status
```

Use the private HTTPS URL printed by status. Relative frontend assets and API
URLs support a path prefix. If that path is already occupied, choose a separate
HTTPS port using documented Tailscale Serve options. Do not expose raw core RPC
or use Funnel. No Tailscale changes are part of development checks.

## Background service and crash recovery

Manual `start` detaches the application from the terminal. For autostart and
automatic application crash recovery on Linux, an operator can install this
user unit **after cutover approval**, replacing every absolute placeholder:

```ini
[Unit]
Description=Shepherdr standalone application
After=network.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/shepherdr
ExecStart=/absolute/path/to/shepherdr/bin/shepherdr start --foreground
Environment=PATH=/absolute/path/to/bun/bin:/absolute/path/to/hc/bin:/usr/local/bin:/usr/bin:/bin
Environment=SHEPHERDR_HOME=%h/.shepherdr
Restart=on-failure
RestartSec=2
KillMode=process
TimeoutStopSec=120

[Install]
WantedBy=default.target
```

Manual service control uses `systemctl --user start|stop|status shepherdr`.
Enabling it is an explicit operator action; the application never enables it.
Choose either service control or detached manual startup as the process owner.
`shepherdr status` reports either; do not start a second supervisor.

On macOS, the equivalent is a user LaunchAgent with `RunAtLoad`, `KeepAlive`
restricted to unsuccessful exit, absolute `ProgramArguments` for
`bin/shepherdr start --foreground`, and an explicit PATH containing Bun and hc.
An operator loads/unloads it with launchctl; no plist is installed automatically.

The application reconnects with a fresh core snapshot after disconnect. Its
recovery loop starts the configured core again if that core crashes; it never
updates binaries or kills holders. Core holders preserve agent programs across
core/server restart. A host reboot ends those programs: the app must report their
real stopped state, rather than automatically rerun potentially completed work.

## Command compatibility

`start`, `stop`, and `status` with no task ID are application lifecycle commands.
`status TASK ...` remains an agent progress report. Core agents receive a private
credential file at launch; their remaining commands go through authenticated
core documents. `shepherdr agent ...` is an explicit spelling inside that
session. Their chat names do not grant authority, and `--url` cannot redirect
their credential to a web server.

Existing 2.0 helper sessions keep their installed authoritative helper and
legacy routing. Development never replaces that helper. At cutover, legacy
code is pinned to `v2.0`, all legacy writers are stopped, the verified legacy
home is backed up and relocated, and only then is the fresh core home created.
The detailed cutover/rollback inventory is a delivery gate, not an installer side effect.

Task dependencies accept full task IDs, a bare ID on the task’s machine, or a bare number in its space.
Use `machine-name:TASK-1` (or the stable machine ID before the colon) to select a main-machine task when its
bare ID also exists locally on a remote machine. Names are resolved when queued; saved edges use permanent IDs.
Unknown, ambiguous, self and circular dependencies are refused without replacing the previous queue.

### Repository SSH in contained runs

Repository operations stay in the trusted checked Git broker; SSH here is only Git transport, never an agent,
mailbox or core transport fallback. Keys and agent sockets remain outside contained agents. Ordinary host aliases,
users/ports, static IdentityFile/IdentityAgent/certificate/known-host paths and literal ProxyJump hosts are copied
into a private checked profile only when Git actually chooses SSH. Nested Include conditions keep native OpenSSH
scoping; every included branch is inspected. Already trusted host keys and noninteractive account authentication
are required. No new host key is silently accepted. HTTP and local Git never parse this SSH profile.

Match exec, ProxyCommand, LocalCommand, KnownHostsCommand, external key-provider programs and unknown SSH
extensions refuse with an explicit adapter message. Forwarding, shared control sockets, environment forwarding,
interactive prompts and host commands are disabled. Only standard git-upload-pack/git-receive-pack services are
accepted. Dynamic host/environment substitutions in account paths, ProxyJump URIs, and nonstandard custom Git
remote programs still need explicit adapters; do not claim those configurations work. Ordinary Include wildcards
are supported, not recursive globstar or brace extensions. This checked profile does not change normal agents or
any user's SSH configuration. Private request/config copies are removed with the repository operation.

## Isolated Autopilot prerequisites

The contained workspace adapter currently requires Linux with working unprivileged
user/mount/network namespaces, `bubblewrap` (`bwrap`) and `flock`. Ordinary native
agent sessions and the app launcher do not use this boundary. Missing prerequisites
refuse contained startup/adoption; there is no unrestricted fallback. The native
Claude Code/Codex CLI and its account must already be installed on that machine.
The build checks used Claude Code 2.1.314 and Codex 0.163.0; Codex's installed
`codex-code-mode-host` companion is mounted with its CLI. Other native versions
still need acceptance. Legacy 2.0's `server/live/autopilot-sandbox.ts` also refuses
non-Linux contained startup; this preserves that platform limit. Ordinary macOS
remote sessions still require their separate acceptance checks.
No dependency installation or live service enablement is part of these checks.

### Ordinary Codex command access

Ordinary Codex agents launch with workspace-write, on-request approvals and command networking enabled so their
CLI can reach its own local core Unix socket. This also enables ordinary command network access; it is not a
network-limited profile. Core socket access already grants shell/file authority as that account. Native workspace
write restrictions are not a security boundary against an ordinary agent that can use core. Use the Isolated
workspace profile when an enforced host/network boundary is required; its outer gateway/allowlist remains separate.
Read-only reviewers keep their read-only native mode and do not receive this networking override.

The setting is per launch, not written to the human’s Codex configuration. Managed Codex requirements still apply;
an incompatible managed policy must be resolved by the operator, never bypassed. See the official
[approval/security configuration](https://learn.chatgpt.com/docs/agent-approvals-security) and pinned
[0.163.0 schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/config.schema.json).
