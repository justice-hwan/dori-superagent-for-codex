# Codex fork migration

Upstream: https://github.com/sisyphuslabs/dori-superagent

Original baseline: `248c291319a1e45db061f1b3eae1cce9640084f7`. Integrated upstream: `44a33bbdff882afa51d0594a75166dc9ac9d7254` (recorded in `.upstream.json`).

Upstream #53 duty stop/resume/status is adapted to Codex threads. The old terminal-only startup change (#51) and terminal-wrapper tests (#55) remain excluded with the removed adapter; no legacy connector or dependency is restored.

The preserved components are the lane registry, evidence-required READY, review receipts, exact-head merge gate, inbox batching, duty cadence and bounded backlog loop. The terminal adapter is replaced by a persistent Codex JSON-RPC client and a private local runtime. Threads are identified by Codex IDs. The CLI is named `dori-codex` and state defaults to `~/.dori-codex`.

The old terminal-agent dependency, usage telemetry implementation, collector registration and bundled messenger CLI are removed from this fork. Older state is intentionally not migrated automatically: its pane identifiers are not Codex thread IDs. Keep old state as an archive. Connectors require separate implementation and authorization.

`up` prepares threads without model work. An explicit send or lane start begins inference. The hourly backlog loop is opt-in. Approvals are surfaced to the operator without automatic acceptance. Shutdown interrupts only recorded owned threads and closes only the child app-server started by this runtime. It never kills another app-server or sends commands to a remote machine.

Desktop sidebar visibility is outside this runtime's contract. This version uses a separate stdio app-server with the user's existing Codex configuration; connecting to a desktop-owned shared server would be a separate transport feature.

## Reversible installation

Install from the reviewed checkout with `bash install.sh`, then invoke `dori-codex` explicitly. It preserves the prior `dori` executable, prior state directory, credentials and external integrations. Stop with `dori-codex down` before changing versions. Keep `~/.dori-codex` to resume saved threads. Do not restore old terminal state into this new directory.

## Updating upstream

Keep an `upstream` remote, fetch changes, and merge into a dedicated branch. Resolve runtime and privacy changes deliberately. Run typecheck, boundary checks, offline tests and the explicit live smoke before using a new runtime. Avoid importing a second CLI with a conflicting command name.
