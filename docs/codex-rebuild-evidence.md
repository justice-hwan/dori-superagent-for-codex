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

Measured external probe timings:

| Observation | Elapsed |
| --- | ---: |
| Initialize acknowledgement | 5 ms |
| Thread creation acknowledgement | 356 ms |
| Turn admission acknowledgement | 172 ms |
| First agent text from turn request | 4,769 ms |
| Turn completion from turn request | 5,142 ms |
| Desktop continuation server-reported duration | 4,471 ms |

First-output and completion include server/model/network work; they are not
pure local orchestration time. Desktop automation took additional interaction
time, excluded from the model duration. No comparable historical baseline
was collected and no old/new speedup is claimed.

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

`bun run ci` completed with exit 0 using genuine standalone **Bun 1.4.4**
and a clean runtime environment:

- Biome: no errors; 7 existing warnings and 8 existing informational diagnostics.
- Both TypeScript projects: passed.
- Knip: passed.
- Source-size gate: 227 files passed.
- Harness tests: **449 passed, 0 failed** across 51 files.
- Retained messenger tests: **392 passed, 0 failed** across 54 files.

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

## Limits

Live Slack/Discord/Telegram login and message delivery were not attempted.
Their current implementations and tests are retained. Native human approval
and user-verification ceremonies were not manually exercised; protocol tests
verify that the harness does not answer server requests, and blocked delivery
does not interrupt a native turn. Read-only review completion and cancellation,
unloaded-thread recovery, explicit ambiguous-delivery recovery, worker ownership
and subscription reconnect are covered by protocol/subprocess regressions.
The backend does not promise simultaneous independent desktop/harness writers.
