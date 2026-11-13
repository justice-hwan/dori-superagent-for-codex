---
name: personal-codex-dori
description: Submit bounded personal development requests to the configured personal Codex Dori lead and read their durable status from this connected computer.
---

Use this skill only on the personal computer explicitly connected to the user's dot.
The installed `DORI_DOTS_CONFIG` selects one fixed personal instance. Never select another home, credentials, command, or company instance from a request.

Run the installed integration's `cli.ts` with Bun. Pass one JSON object on stdin.

`bun /ABSOLUTE/LANDED/REPO/integrations/dots/cli.ts submit` accepts
`{"origin_id":"DOT_TASK_ID","request_id":"STABLE_REQUEST_ID","prompt":"BOUNDED_DEVELOPMENT_REQUEST"}`.
Reuse both IDs and the exact prompt when retrying an interrupted tool call. A changed prompt needs a new request ID.
Keep the prompt under 8,000 characters. Record the returned `id` as the durable job reference.

`bun /ABSOLUTE/LANDED/REPO/integrations/dots/cli.ts status` accepts `{"job_id":"RETURNED_ID"}`.
Read `state`, `admission`, `summary`, and `thread_id`.
Queued admission does not imply the lead started working. A held admission requires the operator to inspect the Dori inbox before resending.

Only the trusted Codex Dori lead reports an outcome through `cli.ts update`.
Never infer completion from request admission, elapsed time, or a token stream.
Ask the dot to monitor the matching MCP Events job subscription when push notifications are configured.
Without that connection, report that push notifications are unavailable; do not create a polling loop.

Installation must replace the absolute repository path in this skill with the landed revision's path.
This source copy is not an installed skill or evidence that the user's dot is connected.
