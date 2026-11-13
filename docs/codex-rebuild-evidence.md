# Codex rebuild evidence

Date: November 13, 2026.

## Foundation and cleanup

Upstream: `sisyphuslabs/dori-superagent`
at `49fba4dc081c9238f01e617b2fd17f548438e624`.
Previous fork HEAD: `5f240924c91c0b259031cc4ef70027bfb46f603e`.
Refresh merge: `497c485` preserves the fork's ancestry and uses the upstream
tree without importing the previous backend.

Before removing `/Users/hwan/.dori-codex`, `lstatSync` established that it was
a directory, not a symlink. Seven old session records contained no owned PID.
`ps -axo pid,ppid,command` had no process referencing that home.
`lsof -nP +D /Users/hwan/.dori-codex` returned exit 1 with empty output.
The directory occupied 1,136 KiB. The exact directory was removed with
`rmSync(path, { recursive: true })`. No process was stopped. Shared Codex
credentials, `~/.codex`, unrelated checkouts and the hc harness were preserved.

## Desktop interoperability gate

Installed CLI: `0.169.0`. Existing managed app-server: `0.167.2`.
Desktop bundle `com.openai.codex` is installed as `ChatGPT.app`,
version `26.1106.51428`, in Codex mode.

A bounded client connected to the existing daemon through WebSocket over its
Unix control socket. This socket does not accept newline-delimited JSON.
The client initialized, created thread
`01a1d541-a2b3-7e53-bdd1-bd387e200ac4`, and named it
`Dori interoperability probe 2026-11-13`. One read-only turn returned
`DORI_APP_SERVER_PROBE_OK`.

The thread appeared in desktop search. Selecting it reopened the exact
conversation, including the prompt and response. A continuation entered and
submitted through the desktop composer returned `DORI_DESKTOP_CONTINUE_OK.`
The external client received the desktop turn's completion event, ID
`01a1d545-9c59-7101-a16b-43eefbbfe6e0`.

This demonstrates history visibility, reopening, sequential continuation and
shared live events through the same daemon. It does not establish that two
independent app-server processes can safely write one thread concurrently.
The backend must respect native busy turns and approval ownership.

The initial timing artifact was overwritten by the desktop continuation callback.
Both completed JSON files now describe turn
`01a1d545-9c59-7101-a16b-43eefbbfe6e0`; their elapsed clock includes the human
interaction interval. The previously reported initial timing numbers are
unverified and withdrawn. The successful desktop gate remains supported by
the inspected conversation and subsequent independent backend desktop trace.
No successful desktop action was repeated to recover timing samples.

Raw probe files and screenshots remain local because the desktop sidebar
contains unrelated private conversation names. They must not be attached to a
public PR unredacted.

## Source-derived responsiveness findings

The prior backend queues ordinary messages while busy and only reconciles them
on a 60-second duty timer. Completion events update state without flushing the
inbox. This adds up to approximately a minute after a turn finishes.

The prior backend also rewrites the full session JSON synchronously on every
streamed text delta and repeats sequential thread-state RPCs before delivery.
These are concrete mechanisms, but their historical latency contribution was
not measured. The fresh backend uses native events for inbox admission and
does not persist every streamed delta.

## Protocol sources

- Official app-server protocol:
  https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Unix control socket WebSocket framing:
  https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs
- The proxy relays raw bytes, including WebSocket framing:
  https://github.com/openai/codex/blob/main/codex-rs/stdio-to-uds/src/lib.rs

Protocol behavior is checked against the installed daemon rather than inferred
from shared on-disk history alone.

## Fresh backend workflow

The rebuilt adapter was exercised through the exported harness API against the
real shared daemon, followed by native desktop interaction. The bounded run
exited 0. Its original trace is retained locally at
`/tmp/dori-live-home-qgNwEr/evidence.jsonl`.

| Scenario | Observed result |
| --- | --- |
| Native lead and duty creation | Both acknowledged their bounded role prompts |
| Native lane start | Read its brief and returned `DORI_LANE_READY` |
| Message sent while working | `QUEUED`; completion event admitted it without a duty-timer wait |
| Durable inbox | Both requested queue markers returned; queue drained |
| Report and READY | Recorded and delivered to the lead through the harness |
| Desktop handoff | Paused harness delivery; another message remained queued |
| Native desktop continuation | Reopened the named lane and returned `DORI_DESKTOP_REBUILD_CONTINUED` |
| Takeback | Reclaimed the idle thread and returned `DORI_TAKEBACK_QUEUE_OK` |
| Done and cleanup | Lane became `done`; all three local thread records closed |

The observed lane thread was `01a1d568-8361-7ff2-ba74-8b70040f571b`.
The desktop response and subsequent harness response were both visible in the
same conversation. Local screenshots `desktop-handoff.png`,
`desktop-draft.png` and `desktop-final.png` accompany the trace.

Fresh-backend timings, rounded to milliseconds:

| Observation | Elapsed |
| --- | ---: |
| Lead creation plus native admission | 961 ms |
| Duty creation plus native admission | 246 ms |
| Lane creation, native admission and lead notification | 933 ms |
| Lead first text from native request | 6,567 ms |
| Duty first text from native request | 3,686 ms |
| Lane first text from lane-start invocation | 3,971 ms |
| Lead first turn, server duration | 6,701 ms |
| Duty first turn, server duration | 3,755 ms |
| Lane first turn including brief read, server duration | 9,575 ms |
| Lane completion event to queued-message admission | 69 ms |
| Native desktop continuation, server duration | 4,837 ms |
| Post-takeback queued turn, server duration | 2,603 ms |

Creation/admission measurements include local persistence and daemon RPCs.
First text and complete-turn measurements include model, tools and network time.
The desktop interaction pause is excluded from model durations.
These are observations under shared-host load, not a controlled benchmark.
No comparable historical baseline was collected and no old/new speedup is claimed.

## Actual up and workers

A second bounded run called the actual `up` implementation with a separate
temporary home, using the shipped scoped wrapper for its worker subprocesses.
Startup created lead, duty, duty-loop and hourly-loop roles in **764 ms**.
A busy lead message was queued and then delivered by the real duty worker.
The hourly worker reported `LOOP started=0 findings=0 asked=0`.

The run exited 0 with an empty lead inbox. Its trace is at
`/tmp/dori-up-live-YKjdQb/evidence.jsonl`. Both owned worker groups were stopped;
their recorded PIDs, 94694 and 94703, were absent from a subsequent `ps` query.
Both local thread records were closed after their turns finished. No production
roles were left running, and the existing hc roles were unchanged.

The final startup-recovery correction was followed by another actual `up`
run, also exiting 0. Its startup observation was **2,172 ms**, and its trace is
`/tmp/dori-up-live-6wwgtf/evidence.jsonl`. Both values are individual observations,
not a benchmark or a speedup claim.

## Required checks

The latest runtime-loader corrective tree completed `bun run --bun ci` with
exit 0 using genuine standalone **Bun 1.4.4** and the injected operator home
and runtime variables unset:

- Biome: no errors; 7 existing warnings and 8 existing informational diagnostics.
- Both TypeScript projects: passed.
- Knip: passed.
- Source-size gate: 253 files passed.
- Harness tests: **527 passed, 0 failed** across 63 files.
- Retained messenger tests: **392 passed, 0 failed** across 54 files.

The complete passing run is `/tmp/dori-adapter-exception-final-ci.log`.
The preceding runtime-loader correction is recorded separately in
`/tmp/dori-runtime-loader-verified-ci.log`.
The earlier `7e8d246` native and static gates are recorded in
`/tmp/dori-trust-corrections-separated-ci.log`. Its messenger subprocess inherited
the operator's `DORI_HOME` and `DORI_RUNTIME=hc`, causing three unchanged
runtime-selection tests to fail. Only that stage was repeated with those
variables unset; `/tmp/dori-trust-corrections-messenger-clean-env.log` records its
392/0 result. No passed stage was repeated and no legacy test was changed.
Earlier isolated runs skipped eight external hc/herdr cases because those
binaries were absent from their test PATH; the latest run reports all 527
harness cases passing. Dedicated CI jobs remain required.

The initial harness-provided Bun launcher reports 1.4.4 but resolves
`process.execPath` to the OmO executable. One existing messenger test launches
that executable with a minimal environment, losing its Bun mode. Three other
existing tests inherit the lane's hc selection. All four failures were
reproduced on the untouched pinned upstream; they are not suppressed or
weakened here. The genuine runtime was staged outside the repository from the
official `@oven/bun-darwin-aarch64@1.4.4` npm archive after verifying its SHA-512
integrity. With that executable and isolated runtime variables, the complete
required pipeline passed.

A final lifecycle audit added two startup regressions. The initial failure
showed an uncertain native admission leaving no registered lane. Native startup
uncertainty now preserves the thread, registers a waiting lane or the role,
and holds its initial input for explicit acknowledgement or resend. The
generic terminal-start cleanup still closes sessions after known failures.

Independent review found that status attempted to resolve every archived lane's
workspace on disk. A deleted unrelated workspace caused `ENOENT` and hid current
lane status. The new regression reproduced that failure before the fix. Status
now compares persisted absolute workspace identities, including the current
lead's original cwd alias, without reading archived directories. Full CI passed
again after this correction; the real delegation check did not need repeating.

## Formal review corrections

The formal review at `b8f9e13` blocked on four findings. Each was reproduced
before its production owner changed; `/tmp/dori-formal-findings-red.log`
records eight failures across the four mechanisms.

- Preauthorized report/READY executed workspace-controlled host hook code.
  Reproductions cover both a writable entry script and a protected entry that
  imports a writable dependency. Management calls now disable unrestricted
  lifecycle hooks; ordinary operator hook tests remain unchanged and pass.
- A sender exit after native acknowledgement but before inbox settlement
  replayed the admitted batch. Stable message identities and a durable confirmed
  batch now reconcile the already-delivered members before another native send.
  Real subprocess exits exercise both settlement boundaries and a newer message
  with identical text. An empty queue also clears its pending confirmation.
- Close raced admission and could be overwritten by stale open ownership.
  Close now shares the submission lock and rereads ownership under it. Worker
  startup uses the same mutex so its later persistence cannot reopen a close.
- Two concurrent `up` calls created duplicate, unregistered roles. A per-home
  startup transaction now encloses the live check, creation and registration.

Targeted green evidence is retained in
`/tmp/dori-formal-hooks-concurrency-green.log`,
`/tmp/dori-formal-crash-green.log` and
`/tmp/dori-formal-targeted-green.log`. The adjacent worker-lock and
post-settlement confirmation failures were also captured separately before
their corrections. No native approval was answered, sandbox policy widened,
shared daemon restarted or production instance launched during these fixes.

## Additional formal boundary corrections

Rereview of `61c2a58` accepted the previous corrections but found four more
boundary failures. `/tmp/dori-second-formal-red.log` records 12 reproductions:
five authority/snapshot placement cases (including symlinks), four concurrent
held-message recovery cases, mixed missing/healthy subscription startup, and
two known-turn review disconnect cases.

The fixes validate resolved capability and snapshot directories against writable
roots in both ancestor directions; reread and update the selected inbox identity
after recovery waits; skip only confirmed missing threads during subscription
refresh; and rejoin/reconcile known review turns before cancellation cleanup.
Non-missing remote errors still propagate. The final targeted owner run records
37 passes with no failures or errors in
`/tmp/dori-second-formal-green-final.log`.

Placement fixtures use child-only HOME directories and do not modify shared
authority state or frozen execution installs. The accepted corrected-source
autonomous proof at `61c2a58` remains applicable to the unchanged happy path:
these cases were not exercised by that run. No desktop or timing gate was
repeated.

## Queue storage concurrency correction

Independent review rejected `7f132b9` because a second process could still
append after the recovery reread and before its whole-file rewrite. Real
writer/appender subprocesses reproduce lost READY for both ack and resend in
`/tmp/dori-queue-process-red.log`.

Queue operations now share a short synchronous file transaction, distinct from
the lock held across asynchronous delivery. Recovery, settlement and native
message identity assignment transform the latest queue under that transaction.
Appenders participate, writes replace JSONL atomically, and migration drains
rotate under the same synchronization. The adapted sender-crash fixture retains
both original crash boundaries at the new atomic storage owner.

`/tmp/dori-queue-atomic-targeted.log` records 58 passes across nine owner suites,
including both real two-process cases, native sender crashes and legacy
forwarding/migration. This changes the exercised storage path, so readiness
also requires a fresh bounded flow from the corrected immutable source.
Earlier raw evidence remains preserved at its original scope.

## Combined host runtime and receipt correction

The formal `7f132b9` receipt additionally identified late worker promotion of
task-writable source and confirmed receipts stranded after local closure.
`/tmp/dori-combined-formal-red.log` records the original four new failures.
`/tmp/dori-worker-promotion-red.log` independently shows task-poisoned bridge
code in the late protected snapshot and both workers executing from the task
checkout. These fixtures mutate only disposable cloned source under an isolated
HOME, never a real frozen install.

The host graph is now pinned before native admission, including direct session
creation and review. Startup renders native role prompts from that copy; both
workers require its command prefix and run with a protected cwd. Their logical
task workspace is carried separately. A derived review-cwd regression failed
before preserving that workspace, then passed with the combined owner suite.
Native identities are assigned at enqueue, while old identity-less records
retain atomic backfill. Receipt-only reconciliation allows closed records,
without changing new-delivery ownership guards.

`/tmp/dori-combined-boundaries-green.log` records 33 passes across seven owner
suites. The sender-exit -> lane-close -> reconciliation case clears its receipt
and queue without another turn, and direct delivery to that closed ref is
refused. The generic process-supervision test retains its environment, output,
birth identity and process-group assertions at the trusted process helper;
the public native entry separately refuses its arbitrary shell command.

The complete combined tree passed CI after repairing the legacy fixture to
seed an actual old-format record instead of the new identity-assigning enqueue.
No assertions or timeouts were weakened. An intermittent idle-watch integration
timeout also reproduced on untouched `724932c` (395 passes, five timeouts in
400 runs). Its cause remains unproven; the watcher and its test are unchanged.
That baseline evidence is retained in
`/tmp/dori-idle-watch-baseline-724932c.log`, and the successful combined pipeline
is `/tmp/dori-combined-final-ci-corrected-fixture.log`.

The subsequent formal receipt at `6af8023` identified two additional trust
boundaries. All native roles now validate authority-home placement even with
the bridge unset. Five direct-role regressions failed by accepting a writable
home before the guard and pass by refusing it before native admission.
Wire fixtures now keep authority and task workspaces separate; all their
ownership, recovery, hook, environment and process-group assertions remain.

Adapter discovery now compiles a single protected dependency bundle with macros
disabled, rejects opaque runtime imports, validates every canonical compiler
input, and permits only builtin external imports. Four regressions reproduced
acceptance of direct, symlinked-package and opaque import/require dependencies
before this correction. All four now refuse them before execution; protected
dependency discovery and admitted outcome delivery still pass.
`/tmp/dori-direct-authority-red.log` and
`/tmp/dori-adapter-closure-red.log` preserve the failures;
`/tmp/dori-direct-authority-green.log` and
`/tmp/dori-adapter-closure-green.log` preserve the focused passing coverage.

Epoch 9 rejected `7e8d246` because `createRequire()` can load code absent from
the compiler manifest. Nine new regressions failed against that committed owner,
covering direct, forged-base and symlink loaders, asynchronous module evaluation,
descriptor getters, async factory/tool calls, result getters and close.
The corrected owner was restored byte for byte after the bounded mutation run.
No historical integration code or native model turn was executed by these tests.

The bounded Bun probe observed that asynchronous ESM evaluation loses its
AsyncLocalStorage context, while synchronous ESM loading retains it. Core now
loads the frozen ESM entry synchronously and retains its runtime resolver policy
during factory and tool execution, serialization and close. Nonbuiltin runtime
module loads are refused, even through loader aliases. Entry-level top-level
await is unsupported; asynchronous initialization remains in the factory.
Descriptors and results are materialized inside the policy so getters cannot
defer code loading until the surrounding host serializes them.

`/tmp/dori-runtime-loader-nine-red.log` preserves all nine pre-fix failures;
`/tmp/dori-runtime-loader-verified-ci.log` records their passing final-tree run
with all existing tests retained. The accepted `7e8d246` native workflow,
desktop continuation and timing evidence remains scoped to that head and its
unchanged behavior; it was not relabelled or rerun for this adapter-only fix.

Epoch 10 rejected local `11715f5` because adapter-thrown objects could defer
workspace loading until MCP formatted their `message`, `toString()` or JSON
data outside the execution policy. The installed stdio MCP server reproduced
eight unsafe cases across discovery and async tool calls: seven loaded only a
private marker fixture, and one crashed discovery. Two ordinary-error controls
passed on the pre-fix owner.

Core now awaits adapter execution inside the policy and converts every thrown
value into a host-owned error carrying only primitive text. Failure formatting
also remains inside the policy; if it throws or returns nontext data, the host
receives a fresh constant diagnostic rather than the original object. Normal
error messages remain intact. All ten transport cases preserve clean stdout,
continue serving a subsequent ping and refuse workspace loading.

The red evidence is `/tmp/dori-adapter-exception-red.log` and
`/tmp/dori-adapter-exception-json-red.log`. The focused correction passed 29
tests in `/tmp/dori-adapter-exception-green.log`; the complete final pipeline
passed 527 harness and 392 messenger tests with zero failures. No native model
acceptance, historical integration execution, desktop or timing gate was
repeated for this exception-only boundary correction.

## Autonomous lead acceptance

The earlier bounded acceptance below is retained as historical evidence.

The external API workflow above verifies transport and lifecycle behavior, not
autonomous delegation. A separate bounded run used the unchanged `prompts/lead.md`
through actual `up`, then submitted a task through the scoped wrapper's
`send lead` command on stdin.

Lead thread `01a1d591-79ae-73e3-a165-7208732bab72` read its role instructions,
wrote `briefs/csv-audit.md`, and invoked the correct scoped wrapper's
`start csv-audit --brief ... --cwd ...` itself. Its tool process failed to connect
to the shared daemon socket. A direct diagnostic confirmed macOS `EPERM` under
`workspace-write`. No lane was created, no result was calculated, and the lead
correctly withheld a completion claim.

Raw evidence is at `/tmp/dori-autonomous-QHDzUY/evidence.jsonl`. Immutable files
ending `-raw-from-trace.json` preserve each observed turn, its thread/turn IDs,
wall timestamps, monotonic elapsed timestamps and clock origin. This failed run
did not capture initial admission or first text deltas; those timings are not
inferred. The observer later received an unrelated probe's thread-start event
and failed while attempting to resume it before its rollout existed. That
observer error is separate from the earlier, independently recorded tool denial.
All locally owned roles were closed; a subsequent process snapshot contained no
process referencing the temporary home.

Two narrower permission probes also failed: a legacy network-proxy configuration
and an active named profile extending `:workspace`, with the exact socket
allowlisted. Their thread-start responses and immutable completed-turn files are
retained under `/tmp/dori-socket-policy-yz8W7R` and
`/tmp/dori-socket-policy-mZZwOC`. The latter response confirms the named profile
was selected; neither probe established working socket access.

No global Codex configuration was changed and sandboxing was not disabled.
The user subsequently approved the constrained management-tool bridge.

A fixed stdio tool proved host placement before implementation: it wrote
`host-placement.json` outside writable roots and reported daemon parent PID
47337. An ordinary `workspace-write` tool was denied a write in the same
directory. The traces are under `/tmp/dori-bridge-placement-3my5jK` and
`/tmp/dori-bridge-placement-408C7T`; the host marker is
`$HOME/.local/share/dori/bridge-placement-probe/host-placement.json`.
Only the named management tool received preauthorization.

The actual autonomous workflow then passed with exit 0. Its immutable trace is
`$HOME/.local/share/dori/autonomous-home-ZOAEkn/evidence.jsonl`, with three
completed-turn `*-raw.json` artifacts and `lead-transcript.txt` in that home.
Each raw artifact contains thread/turn IDs, Unix wall milliseconds, observer
monotonic elapsed milliseconds and the clock origin. Server-start events are
labelled as observations, not local admission acknowledgements; initial native
startup admission was not separately instrumented.

The unchanged lead role on thread `01a1d5b8-f76d-7180-844d-494ae76d9419`
called `dori_start` itself. Lane `01a1d5b9-4a8e-76d0-9b38-ecdc18f0aa91`
read the CSV, calculated rows 3 and sum 89, wrote the compact result, and called
`dori_report` and `dori_ready`. Those notifications stayed queued while the lead
was busy. The lead inspected the recorded result using `dori_status`, read the
result file, closed the idle lane through `dori_done`, and returned
`AUTONOMOUS_LEAD_CONSUMED sum=89 rows=3`. This proves agent delegation and
consumption rather than external orchestration of the lane.

Observed management tool durations were: start 144 ms, report 9 ms, READY 5 ms,
status 2-3 ms, done 10 ms. The bounded run took 76.2 seconds including model,
tools and network work; it is not a controlled latency benchmark. The lane was
`done`, both native roles were idle before local close, both workers were
stopped, and a process snapshot contained no process referencing the home.
No production roles were deployed and the passed desktop gate was not repeated.

## Limits

Live Slack/Discord/Telegram login and message delivery were not attempted.
Their current implementations and tests are retained. Native human approval
and user-verification ceremonies were not manually exercised. Independent review
used a separate file-free probe to confirm that numeric-ID approval and string-ID
tool requests receive no harness response; that probe is not a committed regression
test. Blocked-delivery regressions verify that delivery does not interrupt a native
turn. Read-only review completion and cancellation,
unloaded-thread recovery, explicit ambiguous-delivery recovery, worker ownership
and subscription reconnect are covered by protocol/subprocess regressions.
The backend does not promise simultaneous independent desktop/harness writers.
