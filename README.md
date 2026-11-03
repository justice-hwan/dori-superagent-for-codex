# dori-superagent-for-codex

A local multi-session harness built on **Codex app-server**. Derived from [sisyphuslabs/dori-superagent](https://github.com/sisyphuslabs/dori-superagent), preserving its brief → lane → evidence → review → merge workflow.

[한국어](README.ko.md)

One lead coordinates tasks. Each lane is a persistent Codex thread. A local duty loop batches queued messages, nudges idle work and reports missing sessions. Completion needs evidence; merging needs a CLEAR review at the exact current head/base pair plus at least one passing check.

```mermaid
flowchart LR
  User --> CLI[dori-codex CLI]
  CLI --> Runtime[Local runtime / private Unix socket]
  Runtime --> Codex[Codex app-server / stdio]
  Codex --> Lead[Lead thread]
  Codex --> Lanes[Lane threads]
  Runtime --> Store[Local registry / inbox / receipts]
```

## Install and use

Requires Bun 1.3+, Codex CLI 0.164+ with `app-server`, Git 2.38+ and a completed `codex login`. GitHub review/merge commands also need authenticated `gh` and a configured Git author identity. macOS and Linux are supported; the local transport uses a Unix socket.

```sh
git clone https://github.com/justice-hwan/dori-superagent-for-codex.git
cd dori-superagent-for-codex
bun install --frozen-lockfile --ignore-scripts
bun link

dori-codex up --cwd /absolute/path/to/project
dori-codex doctor
dori-codex send lead --text 'Inspect this project and propose the next authorized task.'
dori-codex read lead
dori-codex status
dori-codex down
```

`up` starts one owned local app-server process and creates/resumes role threads. Without `--auto-loop`, it does not start a model turn until a message is sent. `down` interrupts owned turns and stops this runtime; stored threads can be resumed later. Existing shared Codex services and remote hosts are not stopped. This package does not register any login service or scheduled job.

`bash install.sh` links this checkout's CLI and the `dori-codex` skill. It never pulls updates or starts services. The command name is `dori-codex`, so an existing `dori` command is preserved.

## Tasks and evidence

```sh
dori-codex start fix-login --brief ./brief.md --cwd /absolute/project
dori-codex send fix-login --text 'Also verify the existing regression case.'
dori-codex report fix-login --text 'Regression reproduced; patch under test.'
dori-codex ready fix-login --text 'Patch ready for review.' --evidence https://github.com/owner/repo/pull/123
dori-codex review owner/repo#123
dori-codex merge owner/repo#123 --dry-run
dori-codex merge owner/repo#123
dori-codex done fix-login
```

READY is a claim. The lead must inspect the evidence. A completed model turn does not automatically mark a lane READY or merge its PR. Reviews run in a separate read-only Codex thread against immutable raw Git source and diff, and bind receipts to the repository, head, base and base branch name. Run commands from a clone containing both commits. The full review and metadata are saved locally. Only a successful turn with an explicit VERDICT and unchanged target identity can produce a receipt.

Review snapshots reject absolute or escaping symlinks, including transitive escapes. Reviewer threads suppress automatic project documentation and mark the snapshot untrusted, so its agent instructions and project hooks are reviewed as source.

`merge` checks CI by the captured head SHA and creates a fixed merge commit whose two parents are exactly the reviewed base and head. It records that candidate before pushing, then uses an explicit expected-value lease on the base ref. A concurrent base change rejects the push; branch-protection rejection has no fallback. Retries verify the saved candidate on the remote before attempting another push. This integrates only the reviewed objects and preserves upstream ancestry. Only merge commits are supported.

A PR head can move independently after the last query. Its newer commits cannot enter the fixed candidate. The command reports `INTEGRATED_REVIEWED_PAIR` until GitHub independently confirms the PR is merged at the reviewed head; it never closes a PR containing newer work. Git credentials use the existing authenticated `gh` helper. Missing checks, failed check commands, failures and all-skipped checks are refused.

Busy/blocked threads keep their messages on disk until they can receive a new turn. Inbox batches carry stable delivery IDs to avoid replay after a lost local response. Cursor-covered batches are discarded after a crash; `send` reports delivery of its own message, even when an older batch is being reconciled. A timeout or disconnection without a confirmed start is held as an uncertain delivery across restarts: inspect Codex history, then use `reconcile TARGET --delivered true|false` explicitly. `read TARGET` shows locally received assistant output; it is not a full transcript export. Full thread history stays in Codex's own local storage.

A confirmed failed turn can receive recovery instructions without restarting other lanes. New instructions invalidate a lane's earlier READY evidence once per inbox batch; acknowledgement-only retries preserve evidence produced by that batch. Closing requires READY, an empty inbox and a finished turn, and excludes concurrent instruction admission or evidence changes. A refused concurrent command can be retried after closure finishes.

Failed-turn state survives runtime restarts until a recovery turn starts. Reconciliation resumes a saved thread before checking its current idle state, and refuses concurrent delivery or closure. Backlog admission rechecks each task under the same lease used by drop/decision commands; a task cancelled while another start waits cannot launch from an older candidate list.

An idle resume is checked against the latest persisted turn summary. A missed failure remains failed; missing, unrelated or unfinished outcomes become `recovery` and cannot authorize closure. New recovery instructions can start a fresh turn. Uncertain delivery still requires explicit reconciliation. `read` shows output received by this local runtime; the complete history remains in Codex.

Lane and backlog names cannot be `lead`, `duty` or an existing thread ID. Kickoff addresses the newly allocated thread directly.

## Approval and interruption

New threads use `on-request` approval and a `workspace-write` sandbox. Reviewer threads use `read-only`. No approval is granted automatically.

```sh
dori-codex requests
# Inspect the request, then write its exact response object to a file.
# Command/file approval example: {"decision":"decline"}
dori-codex requests answer REQUEST_ID --json /path/to/response.json
dori-codex interrupt fix-login
# If a send was marked uncertain: inspect Codex history, then state whether it arrived.
dori-codex reconcile fix-login --delivered true
```

Only threads recorded by this runtime can receive messages, be interrupted or archived. Pending questions and approvals are shown by `requests`; answering requires an explicit response file. Credentials remain with Codex's login flow.

Interruption waits for an in-flight submission and confirms the turn's completion event. An unresolved turn or missing confirmation is reported as unconfirmed. Reviews allow 20 minutes of model work, with additional time for setup and cleanup; transport idle limits do not end a running review early.

A pending review question or approval remains available through `requests` while the same review keeps waiting for its result. Answer explicitly in a separate terminal; the review deadline continues to apply and interrupts timed-out work.

## Backlog and duty

The runtime runs duty every 60 seconds. Pause future passes with `duty stop --text maintenance`, inspect with `duty status`, and resume with `duty resume`. This does not interrupt a turn already running; use `interrupt` for that. It nudges idle working lanes at 10 and 20 minutes and escalates at 40; WAITING/blocked work is left alone. A failure in one lane does not stop the others.

Role lookup, creation and registration share a per-home startup lease. Concurrent `up` calls reuse the registered roles or report busy instead of replacing them.

```sh
dori-codex backlog add task-one --brief ./brief.md --priority 2
dori-codex loop --once
dori-codex loop stop --text 'maintenance'
dori-codex loop resume
```

The hourly backlog loop is opt-in (`up --auto-loop`, or run `loop` separately). Its default budget is 3 open lanes and 2 starts per run, subject to host load. Add only authorized tasks. `up --auto-loop` takes effect when starting a stopped runtime.

The loop rechecks current open lanes, host load and its stop switch before each start. Explicit `start` commands allocate outside this loop budget. An item's admission and drop/decision updates share a lease; commands report busy while its start is in progress and can be retried afterward.

## Local state and communication

State defaults to `~/.dori-codex`, separate from older installations. `DORI_HOME` changes it and is resolved to an absolute directory before storage, socket identity, daemon startup and generated commands. Session records, inboxes, requests and logs are private local files. The runtime listens on a mode-0600 Unix socket. A dead runtime/inbox lease is reclaimed under a serialized claim gate. A crash during the short claim section leaves a `.claim` file for explicit owner inspection; it is not automatically removed. Shutdown verifies exit of its own child, using bounded TERM/KILL escalation if needed. `DORI_CODEX_BIN` selects the Codex executable, not a shell command.

There is **no usage collector, install registration, analytics key or telemetry sender in this fork**. Dori's own communication is the local Unix socket and app-server stdio. Codex model requests and user-configured Codex tools/providers still use their normal connections. GitHub operations use `gh`. No Slack, Notion, Kakao or other messenger connector is bundled or started.

This runtime starts its own app-server with the user's existing Codex configuration. It does not attach to the desktop app's live server. Automatic visibility or immediate refresh in the Codex desktop sidebar is not guaranteed; persisted thread IDs can be opened/resumed with compatible Codex clients.

Normal threads use a per-thread workspace permission profile adding the private state directory and exact local Unix socket. A managed proxy uses an empty domain allowlist; this does not grant arbitrary command networking or change global configuration. Review threads retain their separate read-only policy. A stopping runtime is never reported ready; active-work permission failures retain ownership for inspection.

## Verify

```sh
bun run typecheck
bun run check:boundaries
bun test ./test/
# Explicit opt-in: uses the signed-in Codex model for one marker response.
bun run smoke:live
# Explicit opt-in: the model writes only a fixture project and executes report/ready.
bun run smoke:lane
```

Offline tests use an in-memory harness and a fake app-server process, including real JSON-RPC framing and Unix-socket CLI integration. They do not invoke a model, send external messages or control production processes. The live smoke uses an isolated Dori home, archives its test thread and stops its runtime.

## Keep upstream

```sh
dori-codex upstream check
# In a clean local checkout, create a dedicated integration branch:
git switch -c integrate-upstream
git merge --no-commit upstream/main
# Resolve conflicts while preserving Codex runtime and communication boundaries.
# Run typecheck, boundary checks, offline tests and live smoke; commit, push and review the PR.
```

`upstream check` uses `.upstream.json`, verifies the remote identity, fetches the declared branch and lists commits since the integrated SHA. On a fresh clone it registers the declared upstream remote. It never pulls, merges, commits, pushes or schedules an update. A rewritten upstream history requires manual inspection. Advance `integratedCommit` only in the reviewed integration branch after resolving every incoming change. Use merge commits for both upstream integration and the resulting fork PR to preserve ancestry.

Original baseline: upstream `248c291319a1e45db061f1b3eae1cce9640084f7`; the integrated upstream SHA is tracked in `.upstream.json`. Keep the original MIT license and attribution. Upstream integrations must pass `check:boundaries` before adoption. See [migration notes](docs/migration.md).
