# Codex harness

This fork uses current upstream harness workflows with native Codex threads.
Select it explicitly with `DORI_RUNTIME=codex` or `"runtime": "codex"` in the
harness home's `config.json`. Existing hc and herdr selection remains available.

## Setup after merge

Requirements: Bun 1.4.4, git, GitHub CLI, an authenticated Codex installation,
and its local managed app-server daemon. The live desktop check used CLI
0.169.0, daemon 0.167.2 and desktop bundle com.openai.codex 26.1106.51428.
Protocol surfaces are experimental; recheck the installed daemon after updates.

Install dependencies with `bun install --frozen-lockfile`, then
`cd skills/dori-mode/scripts && bun install --frozen-lockfile`.

Use a separate harness home. The backend does not start, stop, update or
reconfigure the shared Codex daemon. If no daemon is running, start it through
your normal Codex setup before opening the harness. `codex app-server daemon
version` shows its version and socket.

Example shell configuration:

```sh
export DORI_HOME="$HOME/.dori-codex"
export DORI_RUNTIME=codex
export DORI_CODEX_MODEL=gpt-6.1-sol
export BUN_BIN="$HOME/.local/share/dori/toolchains/bun/1.4.4/bin/bun"
```

`BUN_BIN` must point to an installed, verified standalone Bun 1.4.4 executable;
the path above is a per-user installation example, not an installer.

Run `/bin/sh scripts/dori-codex.sh up --cwd /absolute/workspace` from this
checkout after merge. The wrapper selects this source and Codex runtime,
preserves `DORI_HOME`, and sets its absolute `DORI_CMD` for model turns.
`BUN_BIN` may select an absolute Bun executable. Do not reuse another
installation's hc wrapper or put a second `dori` command on PATH.

The existing `up`, `start`, `send`, `report`, `ready`, `duty`, `loop`, `review`
and merge-gate commands remain the workflow. `up` opens lead/duty Codex threads
and local duty/hourly workers; it refuses to duplicate live registered roles.
The duty worker uses completion events for inbox flushing, with its normal
periodic pass retained for reconciliation and nudges.

Loop workers retain the pinned source and Bun executable. Their local environment
removes executable search roots writable by the task or native temporary tools,
and startup loader overrides; certificate variables and trusted configuration
remain. Worker commands validate their entry directory and canonical target, then
walk every raw link component of the invocation path in order. A component inside
a writable root is refused before it is followed, so a mutable relay cannot be
retargeted between validation and spawn. Safe configured aliases, including
relative `..` hops, keep their invocation name. The host memory probe uses the
system sysctl.

A detached worker waits on its private stdin pipe before entering its loop.
The launcher observes PID/birth identity, commits ownership, then grants startup.
EOF before that grant exits the unregistered child, including if the launcher is
killed. This handshake adds no polling or registration retry timeout.

The wrapper enables the constrained stdio management bridge. It installs a
content-addressed source snapshot under `$HOME/.local/share/dori/codex-bridge`.
The snapshot, harness home and Bun executable must be outside the task workspace
and native temporary write roots; startup refuses an unsafe placement. Use a
separate task workspace rather than your entire home directory.

The lead uses `dori_start`, `dori_send`, `dori_status` and `dori_done`; a lane
receives only `dori_report` and `dori_ready` for itself. These tools invoke trusted
host lifecycle code with a fixed instance/workspace and role capability.
Management tool calls receive scoped preauthorization; ordinary tools remain
`workspace-write` and native approval requests remain with the desktop.
Unrelated inherited MCP servers are disabled only on these managed threads.
Management reports and READY calls do not run configured lifecycle hooks.
Those hooks execute unrestricted host commands, whose scripts or dependencies
could be writable by a sandboxed lane. Operator CLI lifecycle hooks retain their
existing behavior; the typed outcome adapter is the supported host notification
boundary for a managed lead.

An admitted follow-up invalidates the lane's previous READY and final evidence.
The lane must issue a fresh READY for that work. Queued instructions remain
pending until admission, and `done` refuses closure while any inbox work remains.
Lane sends, READY and closure share the inbox lock; a concurrent operation can
return a busy refusal before accepting new work. Native batch identities survive
sender exit and acknowledgement recovery so replaying a receipt preserves a
newer READY.

For an ambiguous follow-up, operator `inbox ack` records admission before
clearing uncertainty or removing the selected entry. A fresh READY reconciles
the held batch first, so later acknowledgements of its remaining entries retain
that completion. Held entries still require explicit operator recovery.
`resend` preserves message identity and needs fresh READY after actual delivery.

Message identity and submission identity are separate. Before a new delivery,
the harness reserves a unique attempt and persists its queue membership under
the inbox lock. An explicit resend reserves another attempt even when its
message IDs are unchanged. Confirmed receipts retain that attempt through
sender failure and recovery.

An inbox journal records reservation order and the newest confirmed admission,
independently of ordinary lane saves. Older held work cannot move that admission
backward. READY and closure reconcile the lane record against this journal;
replaying an older admission preserves completion for newer work. Existing
held records without ordered metadata remain recoverable without inventing an
original native batch or comparing timestamps.

## Desktop behavior

Use the same managed daemon and Codex home as the desktop connection.
`DORI_CODEX_SOCKET` selects an explicit control socket when necessary. Merely
pointing a separate app-server at the same storage is not a synchronization
contract.

Find a thread by name in desktop search and reopen it. The bounded check proved
that an external turn appears there, a native desktop continuation completes,
and the external subscriber receives that continuation's event. Desktop
discovery can require opening search or refreshing its list.

This supports sequential control and shared live events on one daemon. Before
using the desktop composer, run the scoped wrapper's `handoff lead` (or a lane
key). Harness admission then stays paused durably for that thread. Once desktop
work is finished and idle, `takeback lead` returns admission to the harness.
The native `turn/start` protocol can steer an active turn and provides no
expected-idle guard, so a probe is not an atomic ownership contract. Do not
submit desktop input while the harness owns admission. Busy delivery stays
queued, and an uncertain admission is held for explicit inbox acknowledgement
or resend. Do not use independent server processes as concurrent writers.

## Ownership, approvals and recovery

Each harness home records only the threads and workers it creates. A bare
`codex:UUID` from another home is not authority to control that conversation.
Closing a lane releases its local ownership/subscription and preserves Codex
conversation history. The shared daemon and unrelated sessions stay running.

Answer approvals in the owning Codex desktop surface. The harness does not
auto-approve requests or answer a native turn's approvals. Keep the duty worker
running for prompt inbox delivery; after a restart it reconciles durable inboxes
against live thread state. Held deliveries are never automatically replayed.

If initial native admission is uncertain, startup exits 3 while preserving the
thread and role or waiting lane. Its initial prompt is held in that session's
inbox. Inspect desktop history first, then use `inbox ack TARGET INDEX` if it
arrived, or `inbox resend TARGET INDEX` if it did not. Never restart the same
lane to retry an unknown submission.

Before native inbox admission, message identities are saved durably. A confirmed
batch stays recorded until its messages are removed from the inbox. Recovery
settles those exact identities before another submission, preserving newer
messages even when their text is identical. Uncertain admission still requires
explicit inspection; it is never automatically replayed. Close, worker startup
and handoff share the submission lock. `up` holds a per-home startup transaction
lock across role checks, creation and registration.

Bridge authority and code directories must not overlap a writable root in
either direction. Capability and snapshot directories are checked after
resolving symlinks. A workspace inside those directories is refused.
Held-message recovery rereads the inbox after runtime acknowledgement and
updates only its selected identity, retaining reports appended during the wait.
An owned thread that was deleted does not stop healthy idle subscriptions.
Review cancellation after transport loss rejoins the subscription and checks
durable status for its known turn before interrupting or releasing ownership.

Current queue readers, appenders, transforms and migration rotations share a
short synchronous I/O transaction. It is separate from the delivery lock held
across awaits, so senders can still append while a native turn is being admitted.
Selected updates read and commit under that same transaction and replace JSONL
atomically. Whole-queue replacement is reserved for explicit replacement; live
recovery, settlement and identity assignment use transforms.

Native startup freezes the complete host source before admitting a turn.
Lead/duty prompts and both loop workers use that protected copy. Worker command
prefixes are fixed to its CLI and their executable cwd is protected; their task
workspace remains operator-bound for lane creation and review. Arbitrary shell
worker commands are refused by the native runtime.
Native inbox entries receive stable delivery identities at enqueue. Legacy
entries without identities are backfilled under the queue transaction.
Receipt inspection and acknowledgement may reconcile a locally closed session;
they preserve its closed state and do not permit a new submission.

`DORI_CODEX_SANDBOX` defaults to `workspace-write`; `read-only` is useful for
bounded inspection. `DORI_CODEX_APPROVAL_POLICY` defaults to `on-request`.
Every native launch validates that its authority home is outside writable
workspace and temporary roots, including workers and launches with the stdio
bridge unset. Configuration and ownership records must remain protected in
both modes.
Native reviews always use a fresh read-only thread; their default deadline is
120 seconds, configurable with `DORI_CODEX_REVIEW_TIMEOUT_MS`. Cancellation
interrupts only the review turn created by that invocation.

Sandboxed tools cannot invoke the management CLI directly on the tested macOS
daemon: socket access returned `EPERM`, including two exact-socket policy probes.
The approved bridge resolves this through typed host tools while preserving the
ordinary sandbox. Native role instructions select those tools instead of the
CLI examples in generic upstream briefs. No raw daemon, shell, arbitrary path,
home, cwd, session selection or approval proxy is exposed.

## Optional outcome adapter

An installed integration can provide `leadTools` descriptors and
`createPersonalTools` through an operator-selected trusted module. Configure
`codexBridgeAdapter` in the private harness `config.json` with absolute `module`
and `configPath` paths and its fixed `instance`. Both paths and every executable
dependency must be outside agent-writable roots. Before discovery imports the
adapter, core builds one protected bundle with macros disabled, rejects unresolved
runtime imports, and validates every resolved input, including symlinked packages.
Only builtin imports remain external. The immutable bundle is reused by that
bridge process. Its ESM entry must initialize without top-level await; async
initialization belongs in `createPersonalTools`. An explicit module linker
permits only actual Node/Bun builtins for static and dynamic ESM requests.
CommonJS resolution is checked before its cache, including bare/scoped packages
and caller-selected `createRequire()` bases. Bun's file plugin alone is not the
authority for bare package names. The policy remains active during entry
evaluation, factory/tool calls, result serialization and close. Static bundled
dependencies and runtime builtins remain supported. The default runtime realm
and explicit `import.meta` URL/path/directory metadata preserve trusted factory
globals and Error identity; this does not change the private adapter API.
Thrown failures are converted inside the policy into host-owned errors with
primitive text messages, so MCP formatting cannot execute deferred adapter
getters, string conversions or JSON callbacks outside the boundary.
The lead can then use only `dori_job_status` and
`dori_report_outcome`; the host derives its native thread identity.

Core reserves a recognized instance-scoped Dots job before inbox submission and
permits outcomes only after confirmed native delivery or an explicit inbox
acknowledgement. Queued, desktop-paused and ambiguous messages do not grant
outcome authority. Correlation cannot move to another lead or different work.
The integration owns its database, authentication, subscriptions and delivery;
installing this core hook alone does not connect a native Dot or MCP Events.

Terminal-to-Codex migration is not implemented. Start fresh threads with briefs
and checkpoints rather than trying to resume a terminal agent's process.

## Messenger integration

Current upstream Slack, Discord and Telegram implementations remain under
`skills/dori-mode/scripts/`. Their existing API and terminal session tests are
retained. The messenger session launcher still supports hc/herdr and explicitly
refuses Codex selection. A native Codex messenger connector, service logins and
real message delivery were not implemented or tested by this rebuild.

The harness inbox is available to an existing authorized inbound integration
through the scoped `send` command. That is not a claim that messenger inbound
has been connected automatically.

## Verification

Run `bun run ci` from the repository root with both dependency sets installed.
The regression suite uses local protocol fixtures and no account credentials.
See the rebuild evidence for the separate bounded real-account workflow check,
latency breakdown and anything not verified.
