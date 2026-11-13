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
```

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

`DORI_CODEX_SANDBOX` defaults to `workspace-write`; `read-only` is useful for
bounded inspection. `DORI_CODEX_APPROVAL_POLICY` defaults to `on-request`.
Native reviews always use a fresh read-only thread; their default deadline is
120 seconds, configurable with `DORI_CODEX_REVIEW_TIMEOUT_MS`. Cancellation
interrupts only the review turn created by that invocation.

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
