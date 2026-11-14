# Codex rebuild evidence

Dates: November 13-14, 2026.

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

The combined worker correction passes **574 harness tests across 69 files and
392 messenger tests across 54 files**, both strict TypeScript projects, Knip
and the 264-file raw-line gate. Biome checked 268 files with no errors and the
existing 7 warnings/8 infos. Its first pipeline then stopped on two nullable
stdin reads. The corrected pipe/PID boundary passed the changed-file check and
the failed typecheck plus every remaining stage; the original exit 2 remains
preserved rather than reported as a successful initial pipeline.

The preceding submission-identity correction at `20a7583` passed the complete required local
pipeline: **568 harness tests across 67 files and 392 messenger tests across
54 files**, both TypeScript projects, Knip and the 261-file raw-line gate.
Biome checked 266 files with no errors and the existing 7 warnings/8 infos.
The full suites ran once after static corrections, at unchanged timeouts.
The passing output is `/tmp/dori-submission-identity-verified-ci.log`.
Its exit marker belongs to the existing delivered monitor notification
`f7dc7de6` at `2026-11-14T05:07:12.215Z`, not to that log file:
`SUBMISSION_IDENTITY_VERIFIED_EXIT=0` and `watcher completed (exit code 0)`.

The preceding operator-acknowledgement tree at `78c2144` completed the full required
local pipeline with exit 0 using genuine standalone **Bun 1.4.4**, with injected
operator home and runtime variables unset:

- Biome: no errors; 7 existing warnings and 8 existing informational diagnostics.
- Both TypeScript projects: passed.
- Knip: passed.
- Source-size gate: 259 files passed.
- Harness tests: **564 passed, 0 failed** across 66 files.
- Retained messenger tests: **392 passed, 0 failed** across 54 files.

The complete passing pipeline is `/tmp/dori-operator-ack-final-ci.log`.
Its first run, `/tmp/dori-operator-ack-full-ci.log`, passed static gates but
reported 563 harness passes and one legacy resend failure. The correction had
eagerly assigned an identity during operator resend. Restricting that migration
to open-lane acknowledgements fixed the owner; the existing legacy assertion
was retained unchanged.

The preceding follow-up run, `/tmp/dori-followup-full-ci.log`, passed static gates and
554 harness cases but timed out in the existing idle-watch discovery/inbox case
at the unchanged 15-second limit. That case passed separately on both unchanged
`a35cd00` and the corrected source. Its cause remains unproven. Only the failed
harness stage was repeated with an explicit diagnostic order; it exited 0 in
`/tmp/dori-followup-harness-ordered.log`. The unrun messenger stage separately
exited 0 in `/tmp/dori-followup-messenger.log`. The timeout is retained as a
watcher reliability residual, not claimed fixed by the follow-up correction.
The preceding runtime-loader full passing run is
`/tmp/dori-vm-loader-final-ci.log`.
The preceding lifecycle correction is recorded separately in
`/tmp/dori-lock-worker-full-ci.log`.
The preceding exception-boundary correction is recorded separately in
`/tmp/dori-adapter-exception-final-ci.log`.
The preceding runtime-loader correction is recorded separately in
`/tmp/dori-runtime-loader-verified-ci.log`.
The earlier `7e8d246` native and static gates are recorded in
`/tmp/dori-trust-corrections-separated-ci.log`. Its messenger subprocess inherited
the operator's `DORI_HOME` and `DORI_RUNTIME=hc`, causing three unchanged
runtime-selection tests to fail. Only that stage was repeated with those
variables unset; `/tmp/dori-trust-corrections-messenger-clean-env.log` records its
392/0 result. No passed stage was repeated and no legacy test was changed.
Earlier isolated runs skipped eight external hc/herdr cases because those
binaries were absent from their test PATH; the latest run reports all 564
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

The administrator's formal review subsequently blocked published `368509b` on
two additional lifecycle defects. A deterministic three-contender filesystem
interleaving retained two lock owners during stale replacement. Injected worker
identity and `ENOSPC` failures left a real spawned wrapper alive; the persistence
case also retained a running descendant. Their meaningful combined baseline is
`/tmp/dori-formal-lock-worker-confirmed-red.log`. A separate missing-identity
baseline incorrectly resolved startup and is retained at
`/tmp/dori-worker-missing-identity-red.log`; the corrected owner was restored
byte for byte immediately after that bounded mutation.

Lock acquisition, reclamation and holder lifetime now share one nonblocking
OS-backed SQLite write reservation. The reservation's inode remains persistent;
only the legacy PID metadata is removed on release. A real child-process
termination test proves the OS reservation releases for stale-owner recovery.
All existing live/dead PID, other-host age, release and delivery tests remain.

Worker startup retains its direct child handle until identity and persistence
succeed. Any post-spawn failure kills only that still-owned process group and
awaits the wrapper's exit before rethrowing the original failure. A worker
without observable identity is rejected and cleaned up rather than saved
without birth identity. Normal scoped worker output, close and refusal to
signal an unrelated persisted PID remain covered.

Focused combined coverage passed 12 tests in
`/tmp/dori-formal-lock-worker-green.log`. The complete combined pipeline exited
0 with 532 harness and 392 messenger passes, both typechecks, Knip and the
253-file LOC gate. No suppression, skipped test, timeout increase, root
package/lock change, auth retry or partial-candidate native/model acceptance
was used. Because these fixes affect storage and worker lifecycle, the
administrator authorized one affected-source autonomous acceptance at `4cfb61f`.
It passed with real lead self-start, lane Python CSV computation (five rows,
sum 167), report/READY, lead evidence reading and `done` returning `closed:true`.
All five owned records closed without uncertainty/confirmation; both worker
PIDs and three exact capability-path sidecars were absent after cleanup.
The accepted receipt is `/tmp/dori-lifecycle-acceptance-4cfb61f.json`; three
immutable raw turns under
`$HOME/.local/share/dori/lifecycle-autonomous-home-sfcMFe` retain hashes, IDs and
wall/monotonic origins. This source-specific acceptance is not repeated or
retagged for the subsequent adapter-only correction.

## Bare-package loader correction

The formal `4cfb61f` review found that Bun 1.4.4's file plugin does not intercept
bare package names. A real workspace package executed through a forged
`createRequire()` base despite the earlier absolute-path guard. Both bare and
scoped discovery cases fail on unchanged owners. Extended factory, call,
serialization and close cases also fail for bare, scoped and pre-cached
workspace packages: `/tmp/dori-bare-package-lifecycle-red.log` records 14
meaningful failures while the Node/Bun builtin positive control still passes.
The corrected owners were immediately restored byte for byte after that run.

The protected unsplit ESM bundle now has an explicit `SourceTextModule` linker
for static/dynamic ESM requests, with only actual Node/Bun builtins exposed
through `SyntheticModule`. A separate execution-scoped CommonJS resolution
check runs before cache lookup and is independent of caller-selected bases.
Top-level await is refused; async factories, admitted-thread callbacks and
host-owned failure materialization remain supported. Config fields, static
exports and factory API are unchanged.

Pinned runtime probes excluded two partial approaches: CommonJS hooks alone
miss dynamic ESM, and a global `onLoad` callback cannot fall through by returning
undefined. The explicit VM evaluation preserves execution context, verified
before implementation. No one-package filter or type suppression was added.

Focused corrected coverage passed 44 cases. Full
`/tmp/dori-vm-loader-final-ci.log` exited 0 with 547 harness and 392 messenger
passes, both typechecks, Knip and the 255-file LOC gate. A first-bound positive
case performs actual SQLite work, uses static/dynamic Node builtins and
CommonJS aliases, reads configuration through `Bun.file`, awaits the real
admitted-thread callback and constructs the expected CLI metadata using
`process.execPath` and explicitly initialized `import.meta.dir`.
Installed-MCP plain-error controls preserve Error identity and diagnostics.
No new native/model, UI/timing, historical adapter, authentication or publishing
run was used for this correction.

## Follow-up admission and closure correction

Formal review of `a35cd00` returned BLOCK despite independent approval and four
successful remote CI jobs. Production delivery left old READY evidence intact,
and closure could strand instructions queued while a lane was busy.

The pre-fix production/wire regression run in `/tmp/dori-followup-red.log`
recorded three failures: delivered follow-up closed without fresh READY,
busy-to-idle closure with pending work, and a send admitted during an actual
close barrier. Two recovery controls passed on that base.

Lane instruction enqueue, READY and closure now share the existing inbox lock.
Closure merges forwarded inbox work and refuses pending entries while holding
the lock through native close and durable completion. Closed lane targets refuse
new instructions. Role inbox appends and the short queue storage transaction
remain unchanged.

Successful admission clears prior READY/final evidence and durably records the
batch identity before queue settlement. READY reconciles a confirmed native
admission before writing fresh evidence. Replaying that receipt then preserves
the newer READY. Stable lane message identities also distinguish repeated
instructions with identical text and timestamps.

Eight regression cases cover admission-save, settlement and acknowledgement
failure; actual sender exit before/after settlement; pending busy-to-idle work;
stale completion; and the actual close/admission race. Removing the durable
identity guard caused all five fresh-READY recovery cases to fail in
`/tmp/dori-followup-identity-mutation.log`; the exact guard was restored.
All eight passed in the complete 555-case harness run.

The administrator subsequently accepted one bounded normal follow-up flow at
exact `5add985`, recorded in
`/tmp/dori-followup-acceptance-5add985-locale.json`. A real native lane published
initial READY, remained busy at a FIFO barrier, and received queued instructions.
After idle, the actual MCP close call refused pending work. Admission then
cleared old completion; the follow-up calculated 17 + 29 = 46 without READY,
and close refused again. Fresh native READY allowed closure with an empty lane
queue. Three immutable raw turns retain IDs, exact source/digest, clock origins
and hashes. Both owned records closed and capability-matched processes exited.

Its original setup attempt failed before any RPC because the process observer
assumed English timestamps on a Korean-locale host. The original failed receipt
and run-once guard remain intact. An own-PID observation-only preflight proved
the cause; the administrator separately released the corrected fixture with
`LC_ALL=C` only on the `ps` child. Both actual thread configurations retained
`workspace-write` and `on-request`. That trace proves only the normal follow-up
flow at `5add985`; older `4cfb61f` lifecycle and desktop/timing/adapter evidence
retains its original scope.

## Operator acknowledgement correction

The existing reviewer then BLOCKed `5add985` on a source-traced operator path:
an accepted turn with a lost response becomes held without a confirmed receipt.
Operator `inbox ack` removed it without admission bookkeeping, allowing stale
READY to close the lane. A pre-owner production/wire run reproduced current and
legacy variants: 15 passes and two failures in `/tmp/dori-operator-ack-red.log`.

Held lane entries now retain the identity of the actual attempted batch.
Acknowledgement records its admission before uncertainty resolution or removal,
and marks the remaining batch members as reconciled under the existing inbox
lock and short queue transaction. Fresh READY reconciles that same held batch
before writing completion, so later selected acknowledgements preserve it.
Legacy held entries use their selected stable identity without inventing an
unavailable historical batch. Role recovery and legacy resend identity remain
unchanged. A newly delivered resend requires fresh completion even when stable
message identities are retained.

Nine wire regressions cover stale closure, fresh completion, selected old-batch
acknowledgement alongside a newer confirmed receipt, interrupted queue and
uncertainty recovery, legacy entries and resend. Closed native receipts still
reconcile after local closure without a new submission. The existing follow-up,
legacy held-concurrency and separate-process queue tests remain intact.

The first replay mutation survived and exposed a test gap; it is retained in
`/tmp/dori-operator-ack-replay-mutation.log`. After strengthening the real
newer-receipt case, removing replay protection caused one meaningful failure;
removing READY reconciliation caused two; treating a new resend as receipt replay
caused one. Every mutation was restored byte for byte before the next.
The final complete pipeline passed 564 harness and 392 messenger tests.

No native/model acceptance was repeated for this operator path. Its response-loss
and operator recovery coverage is controlled production/wire evidence. The
accepted normal native flow remains bound to `5add985`; the administrator owns
any decision about further live coverage. The earlier watcher timeout remains
unproven and is not claimed fixed by this correction.

## Submission identity and ordered recovery correction

The next independent review blocked `78c2144` on two source-traced combinations:
confirmed resend recovery after interrupted invalidation could reuse the old
message-derived admission ID, and older held reconciliation could replace the
newer identity before fresh READY.

Both were reproduced before production owners changed.
`/tmp/dori-submission-identity-red.log` records 9 passes and 2 failures. Each case
asserted actual second wire acceptance and a durable confirmed receipt first.
Recovery then wrongly allowed stale closure in one case and erased the recorded
fresh result in the other.

The correction reserves a distinct durable submission before native delivery,
while retaining enqueue message IDs. Queue membership and receipts retain that
attempt. A separate inbox journal owns monotonic reservation and admission order;
ordinary lane saves cannot overwrite it. Normal success, receipt recovery and
held acknowledgement share one admission path. READY and closure reconcile its
lane projection. Ordering uses durable reservations, not hash or wall-clock order.
The native batch and public adapter contracts remain unchanged.

The first affected run had 22 passes and 2 failures: existing fault injection
targeted the first store write, which now occurred before native acceptance.
Its fault is now armed by the existing actual wire-admission observer, with
an additional confirmed-receipt precondition and every original assertion
retained. The corrected affected run passed 52 cases across seven files.
The final focused baseline passed seven cases, including both original
reproductions, pre-admission persistence failure and stale lane projection.
Four causal mutations each produced six passes and one intended failure:
reusing message identity for attempts, admitting older work as newest, bypassing
persisted queued reservations, and omitting closure projection reconciliation.
Each mutated owner was restored byte for byte before the next mutation.
The first full invocation passed Biome and stopped on two new expected-ID
typing errors. Explicitly rejecting a missing queued native ID fixed them
without casts or weakened assertions. The next invocation passed both types
and Knip, then found a 276-line test file. The four new cases moved unchanged
to `test/lane-submission.test.ts`, sharing the unchanged acceptance setup in
`test/fixtures/ready-lane.ts`; every previous assertion remains.
Both complete suites were still unrun before those static corrections.
The resulting full pipeline passed 568/0 harness and 392/0 messenger tests,
with all required static gates. All earlier outputs remain preserved.

No native/model, desktop, timing, CSV or previously accepted lifecycle run
was repeated. The actual normal follow-up trace remains scoped to `5add985`.
The historical watcher timeout remains unproven.

## Worker executable and registration correction

The exact `20a7583` formal review blocked two source-traced worker findings
despite its independent APPROVE and four successful remote CI jobs. The helper
exited before merge. No merge release was created.

Before owner edits, `/tmp/dori-worker-boundary-red.log` recorded three actual
failures. The real default hourly worker completed a pass but ran workspace
`sysctl` and `gh` instead of the trusted command control. An independent call
to the real default memory reader also ran workspace `sysctl`. Neither test
replaced the host probe. A real launcher killed at its actual registration
save barrier left the unregistered child executing its loop. FIFO output/EOF
and matching PID/birth observations supplied event-driven proof and cleanup.
`/tmp/dori-worker-alias-red.log` also reproduced a trusted-directory file alias
resolving into workspace code.

The combined correction filters only the worker's environment/search path,
validates resolved executable entries and targets, and pins system `sysctl`.
Useful configured command aliases retain their invocation name after validation.
The initial physical-target invocation lost that name; the preserved
`/tmp/dori-worker-trusted-alias-red.log` exposed this compatibility error.
`/tmp/dori-worker-entry-red.log` separately proves why mutable workspace entries
must be refused even when their target is safe.

Startup now waits on a private stdin pipe until PID/birth registration is
committed. Launcher death closes the pipe, so an unregistered child exits before
its loop. Existing catchable identity/ENOSPC and group-close assertions remain;
the ENOSPC fixture targets registration without waiting for forbidden pre-start
execution. The affected retained suite passed ten cases. The final six direct
cases passed, including actual child exit and absence of an hourly run file.
Five isolated causal mutations each failed at their intended boundary and
restored the captured owner hashes. Removing the system probe pin ran workspace
`sysctl`; removing canonical target validation ran workspace `gh` through its
file alias. An unfiltered search path lost the trusted command control while
entry validation still refused the workspace command. Omitting entry-directory
validation allowed a mutable workspace entry. Granting startup before saving
ownership left the actual loop executing after launcher SIGKILL while all three
catchable identity/ENOSPC controls still passed.

The complete corrected continuation passed 574 harness and 392 messenger tests,
strict types, Knip and the 264-file LOC gate. The initial gate's nullable-pipe
type errors remain in `/tmp/dori-worker-boundary-full.log`; the successful
continuation is `/tmp/dori-worker-boundary-full-continuation.log`. Capturing the
returned pipe with the existing PID validation preserves direct FD logging and
fails closed at the process boundary without casts or an optional grant.
The final packet binds these source and log hashes. Independent reviewer
continuation, publication and formal gates remain administrator-owned.

No native/model, production, desktop, timing or accepted lifecycle flow was
repeated. The actual normal native trace remains scoped to `5add985`; the
historical watcher cause remains unproven.

## Intermediate executable link correction

The same independent reviewer blocked `cde3dc6`: a protected alias such as
`protected/bin/gh -> workspace/relay -> protected/libexec/gh` passes canonical
entry and target checks, yet the original alias is spawned afterwards, so a
retargeted relay runs writable code. Directory links share the cause.

Before owner edits, `/tmp/dori-worker-traversal-red.log` recorded 1 pass and 9
failures across the workspace, native temporary directory and `/tmp`, each with
file, directory-target and parent-directory relays. Every case first ran the
real safe target and matched its realpath; the existing `Bun.spawn` boundary
then retargeted the relay synchronously, without sleeps, and each private
writable marker ran. The safe multi-hop alias control passed.

The correction reuses the existing writable-root policy and walks the raw
invocation path component by component, refusing a writable component before
following it. Link targets are not normalized ahead of traversal, so `..` is
applied to the physical directory a link reached. The worker still spawns the
validated alias, preserving invocation names. Registration, EOF, environment,
certificate and cleanup behavior is unchanged.

Added coverage includes a `parent-components` chain whose lexical normalization
would skip the writable hop, and a protected `relay/../implementation` alias
that must keep the name `gh`. Five owner mutations each failed at their
boundary and restored exact owner hashes: removing the component ownership
check or bypassing the walker ran all twelve writable markers; normalizing link
targets ran the three parent-component markers and broke the protected parent
alias; returning the canonical target lost the invocation name; refusing every
link broke both protected aliases.

The first complete pipeline after correction failed strict typecheck on the new
test's `Bun.spawn` interceptor; that log is retained. The interceptor now
types its options from the argv overload and asserts the argv form. The final
packet binds the passing pipeline and every log hash. No native/model,
production, desktop, timing or accepted lifecycle flow was repeated. The
historical watcher cause remains unproven.

## Writable root identity and link bound correction

The same reviewer blocked `8745551`: the walker compared component spellings,
so on a case-insensitive volume `WORKSPACE` reached the writable `workspace`
root unrefused. A relay retargeted after validation could again run writable
code, or become a relative self-link that the walker expanded without bound.

This host's APFS volume is case-insensitive: each writable root's swapped-case
spelling had the root's device and inode. Before owner edits,
`/tmp/dori-worker-link-identity-red-final.log` recorded 0 pass and 5 failures.
The workspace, native temporary and `/tmp` case variants each first ran the
real safe target, then the synchronous `Bun.spawn` retarget ran the private
writable marker. Two self-links, created at the walker's first visit to the
relay after initial `realpath` validation, exceeded an event-driven ceiling of
1000 expansions instead of hanging the test.

The walker now compares each component's device and inode with the writable
roots before following it, and fails closed with the ownership error after 40
link expansions. Raw traversal order, `..` handling, invocation names and
worker registration, environment, certificates and cleanup are unchanged.
The affected suites passed 31 cases. Eight owner mutations each failed at their
boundary with exact restoration: removing the identity check ran fifteen
writable markers; comparing spellings ran the three case variants; removing the
bound restored unbounded expansion; a non-ownership bound error failed closed
with the wrong kind; the earlier normalization, walker bypass, canonical-name
and blanket-link mutations still failed as before.

## Canonical worker spawn

The same reviewer blocked `98b30d8`: root identity cannot see a mount or
firmlink that exposes a writable subtree at another path. Epochs 17 to 19 share
one cause: spawning the alias re-traversed links after every check. The
administrator chose to validate once and spawn the canonical file.

Before owner edits, `/tmp/dori-worker-canonical-spawn-red.log` recorded 0 pass
and 1 failure. A relay in a protected directory, standing in for an exposed
writable subtree, passed every walker check; retargeted at the existing
`Bun.spawn` boundary, it ran the writable file instead of the safe one.

On pinned Bun 1.4.4, the spawn `argv0` option reached native children as their
invocation name but not shebang scripts, which receive their canonical path
from the kernel. The administrator accepted this contract change: the worker now
spawns the canonical file with the original alias as `argv0`. The host
trusted-alias case now uses a compiled native control that exits unless its
`argv0` is `gh`; the protected multi-hop controls run the pinned Bun binary as
`gh` and assert `process.argv0`. Each original security assertion is retained.

The walker remains before spawn because a writable link could otherwise choose
which protected file is validated. A new decoy regression proves that refusal.
Existing host mounts, firmlinks or hard links that expose writable storage at a
protected path remain an explicit deployment invariant; no mount scanning was
added and no mount was created.

## Review MCP isolation and foreign lane keys

The exact `b8c60b6` formal review blocked two findings after its independent
APPROVE and four successful remote CI jobs. Review threads were read-only but
kept MCP servers inherited from the user Codex config, and `dori_start` reused
done or lost lane keys owned by another workspace.

Before owner edits, `/tmp/dori-review-bridge-isolation-red.log` recorded 1 pass
and 3 failures. A real review `thread/start` through the fake daemon, with a
fixture `CODEX_HOME` declaring two harmless servers, carried no MCP override.
The actual `dori_start` management tool rewrote a foreign done lane and a
foreign lost lane to this workspace and overwrote their briefs. Reusing an
archived key from the same workspace already passed.

The managed-role override is now a shared helper, applied to review threads as
well; the user's Codex config is never edited. `dori_start` refuses a key whose
existing lane belongs to another workspace before writing anything. Same
workspace reuse, canonical spawn and worker contracts are unchanged.

## Configuration layers and concurrent lane starts

The same reviewer's continuation at `fa3ed3c` completed without a verdict, so
it provides no coverage. Read-only research then found that the `fa3ed3c`
override named only servers from the user `config.toml`, while Codex also
merges system, enterprise, profile and project layers. A project
`.codex/config.toml` in the reviewed checkout could therefore add a server.

The fake daemon now answers `config/read` from fixture files only. Before owner
edits, `/tmp/dori-config-layers-race-red-final.log` recorded 0 pass and 7
failures. Review threads, trusted or untrusted, and a managed lead thread left
the project server enabled and never read the configuration. A failed or
malformed read still let both threads start. Two concurrent starts of one new
key, from one workspace and from a workspace plus the loop path, each started
two threads.

Managed and review threads now call `config/read` for the exact thread folder
with every layer and disable each declared server, refusing to start on a
failed or malformed read. This replaces the user-file read, which in earlier
tests could have read the developer's own Codex config. Lane starts take a
per-key lock built on the existing inbox lock, and the workspace ownership check
runs under it. The legacy `managed_config` layer remains an operator-owned
residual.

## Admission binding and lane lock reservation

The same reviewer blocked `ff94bfc`: a server added between `config/read` and
`thread/start` had no override, and a reused process ID could leave a crashed
lane start locked. Codex sources showed no per-thread deny-all setting and that
MCP servers start at `thread/start`, so the administrator chose a post-start
check. `/tmp/dori-admission-binding-red.log` recorded every new admission case
failing on unchanged owners; `/tmp/dori-lane-lock-pid-reuse-red.log` recorded
the refused lane start against a live unrelated process ID.

Review and managed threads now re-read the configuration and list the thread's
MCP servers after start, closing the thread before any turn when an undisabled
server appears or a read fails, is malformed or hangs. The lane lock alone
treats its SQLite reservation as authoritative. A server added in the window is
still spawned at thread start; an operator MCP allowlist closes that residual.

The same reviewer then blocked `9b0fc74`: a failed `thread/unsubscribe` replaced
the refusal and could leave a managed thread unrecorded. Codex sources show
that `thread/unsubscribe` only detaches one client, while `thread/archive`
shuts the thread down but proceeds after a shutdown timeout.
`/tmp/dori-refusal-cleanup-red.log` showed both paths reporting the cleanup
error instead of the refusal and leaving nothing recoverable. Refused threads
are now recorded first and archived; a failed archive keeps the refusal as the
error and leaves an uncertain open record. Unconfirmed MCP teardown joins the
operator allowlist residual.

The reviewer then blocked `fb84cc9`: a failed record save could still replace
the refusal, the early managed record looked like an ordinary open thread, and
the test readiness signal preceded the SQLite gate closing.
`/tmp/dori-admission-recovery-red.log` showed the save error replacing the
refusal, a crash-left record accepting a delivered turn, and a recovered record
being overwritten. The refusal now always survives with every secondary failure
attached, managed threads carry a pending-admission state until a locked commit,
and the runtime-pin test waits for the hourly tick to release its loop lock.

The reviewer then blocked `cef8e0f`: the idle watch and probe still resumed
pending threads, and review threads lacked the pending lifecycle.
`/tmp/dori-pending-readers-red.log` and `/tmp/dori-pending-recovery-red.log`
showed both resumes, a review crash record accepting a delivery, a refused
commit left unarchived, and a crash-left record left open by the duty refresh.
Admission now holds the submit lock across the whole window, review threads use
it, refused commits are archived, and the duty refresh archives abandoned pending
records without resuming them.

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
