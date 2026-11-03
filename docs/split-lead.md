# One conversation and an internal work lead

Use one conversation for requests, pivots and results. An internal work lead coordinates the actual lanes and inspects their completion evidence. Routine START, REPORT, READY, retries and nudges stay with that coordinator. Verified completions are collected into a short report; important failures and concrete decisions can be reported immediately.

Start the explicitly authorized shared connection with:

```sh
dori-codex up --connect ws+unix:///absolute/socket --lead EXISTING_CONVERSATION --split --cwd /project
```

`conversation` is the existing protected chat. `lead` is a separate Dori-created internal coordinator. `duty` remains code. Starting split mode allocates the work lead without starting a model turn; requests arrive through `send lead`. Repeating `up` preserves those roles and split mode, including after a wrapper restart. Stop and restart the Dori wrapper when installing changed runtime code; a live health response does not reload modules. The shared Codex server and conversation are never restarted, archived or interrupted by Dori.

The conversation agent should send authorized work to `lead`, keep talking to the owner, and avoid performing a lane's long implementation itself. The internal work lead uses the task ledger to find the related session. An exact key or native thread ID selects a task; a text query must identify exactly one open task before a pivot is allowed. Ambiguous matches are listed for one short clarification rather than guessed.

## Changing running work

```sh
dori-codex task find login
dori-codex task show fix-login
dori-codex pivot fix-login --expected-revision 1 --text 'Use email login instead of Google'
```

A pivot first commits a new task revision, invalidates older READY evidence, and durably records the instruction. An active, unblocked, proven owned turn receives `turn/steer` against its refreshed exact turn ID. An idle worker receives the instruction in a new turn. Native replacement turns are never steered as owned work. Native approval/input blocks keep the instruction queued; Dori does not answer them or interrupt the worker to force delivery. Ordinary `send` retains its existing busy-worker queue behavior.

The worker's brief includes its immutable native instance. In split mode every worker ACK, REPORT, READY and coordinator DONE must name that instance. Reusing a lane key cannot make an old worker complete the new lane.

```sh
dori-codex ack fix-login --instance WORKER_THREAD --revision 2
dori-codex report fix-login --instance WORKER_THREAD --revision 2 --text 'Email flow implemented; tests running'
dori-codex ready fix-login --instance WORKER_THREAD --revision 2 --text 'Email login verified' --evidence RESULT_LINK
dori-codex done fix-login --instance WORKER_THREAD
```

Queued, delivered and acknowledged are distinct states. A transport response means input was accepted; only a matching worker ACK records that the new direction was understood. READY must match the latest revision and requires that ACK after a pivot. Old or future ACK/READY/REPORT commands are refused. Interruption is an explicit separate operation; already executed effects are not automatically rolled back by steering.

## Reports and Pages

`done` records a verified completion in a durable outbox before allowing the task key to be reused. Normal completions wait at least five seconds and share a report with up to seven nearby completions; the existing duty pass flushes them, normally within about a minute and at most the next two passes. No new recurring schedule is created. Use `notifications flush` for an explicit immediate flush. Urgent decision/failure notices do not pull unrelated completions forward.

```sh
dori-codex notify fix-login --kind decision --text 'Implementation is verified' --decision 'Deploy now?' --evidence PR_LINK
dori-codex notifications list
dori-codex notifications flush
```

Incoming conversation reports contain short results and evidence, not raw logs or receipt commands. The conversation agent reads `notifications list`, matches the submitted batch's immutable `message.text` with the report it actually received, and records receipt using `notifications ack BATCH_ID`. A transport submission is not a model receipt, task acceptance or Pages publication. Unknown submission outcomes retain their frozen inbox batch and require native-history inspection/reconciliation rather than a blind retry.

Pages is the owner-facing dashboard, updated with the connected Pages tool by the conversation agent. `task document KEY` exports the source for a task's result Page under **요약 / 정할 것 / 상세**. It does not publish anything itself. Keep task/native-instance/revision identity in the handoff, reject stale projections, and link lead/assignee names to their real Codex threads and hosts. Mark publication complete only after the Page tool's real receipt/link. Preserve human edits.

## Messenger origins

See [upstream messenger support](messengers.md). Slack, Discord and Telegram use the same native task identity and direction ledger. `admitMessengerRequest` accepts only an authenticated host adapter's verified owner event. New requests enter the internal work lead; follow-ups on a bound task become idempotent pivots. Bind the native thread instance, not a reusable lane key. External completions remain pending for their captured origin and never fall back into the Codex conversation.

```sh
dori-codex messenger bind fix-login --origin origin.json
dori-codex messenger status
dori-codex messenger reply fix-login --config explicit-config.json --id stable-delivery-id --text 'Result'
dori-codex messenger report NOTICE_ID --config explicit-config.json
```

Only explicit reply/report commands read the explicitly supplied configuration file and enable transport. Configuration must identify the same platform/account/workspace as the original task. Credential values are never stored in the task/outbox journal. No default token lookup, listener, presence session or message fan-out is enabled. Platform registration, authenticated event ingestion and account setup remain explicit deployment work; no live platform was connected during implementation.
