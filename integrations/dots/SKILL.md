---
name: personal-codex-dori
description: Submit bounded personal development requests to the configured personal Codex Dori lead and read their durable status from this connected computer.
---

Use this skill only on the personal computer explicitly connected to the user's dot.
The installed `DORI_DOTS_CONFIG` selects one fixed personal instance. Never select another home, credentials, command, or company instance from a request.

When the administrator has attached the confirmed personal tools to this local task, use `dori_submit_request` and `dori_job_status`. Tool arguments never select configuration, principal, runtime home, command, or thread binding.

`dori_submit_request` accepts
`{"origin_id":"DOT_TASK_ID","request_id":"STABLE_REQUEST_ID","prompt":"BOUNDED_DEVELOPMENT_REQUEST"}`.
Reuse both IDs and the exact prompt when retrying an interrupted tool call. A changed prompt needs a new request ID.
Keep the prompt under 8,000 characters. Record the returned `id` as the durable job reference.

`dori_job_status` accepts `{"job_id":"RETURNED_ID"}`.
Read `state`, `admission`, `summary`, and `thread_id`.
Queued admission does not imply the lead started working. A held admission requires the operator to inspect the Dori inbox before resending.

Only the admitted Codex Dori lead reports an outcome through its role-bound `dori_report_outcome` tool. The trusted host derives its thread from current admission records; never supply or claim a thread binding.
Never infer completion from request admission, elapsed time, or a token stream.
Return the durable status/result to the dot through the supported result of the local task that dot created. Record actual Dot receipt separately from a successful local tool call.
Custom MCP Events can also monitor a matching job when explicitly configured. Native task result delivery does not prove an Events subscription or acknowledgement. Do not create a polling loop.

The host-side CLI remains available at the configured landed integration path. A denied sandbox operation must not be retried through that CLI or another tool. If the confirmed personal tools are absent, report the missing attachment to the administrator rather than inventing a working invocation.
This source copy is not an installed skill or evidence that the user's dot is connected.
