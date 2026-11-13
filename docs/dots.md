# Personal Codex Dori and Dots

This integration is a bridge to one configured Codex Dori lead. It does not start a second lead or send turns directly to Codex app-server. The existing Dori inbox decides whether a request is delivered, queued, paused for desktop ownership, or held for operator reconciliation.

The hc lead remains the system administrator. Codex Dori and the dot manage work. This implementation targets the personal instance; a future company instance needs its own home, database, OAuth audience, account allowlist, and explicit tool registration. A tool caller cannot select a home, shell command, credentials, or another instance.

## Connection status

Local regression tests are not proof of a connected dot. The actual account was inspected on November 13, 2026: ChatGPT was signed in with a Pro plan and a Work surface; GitHub CLI authentication was independently verified for `justice-hwan`. Neither observation proves Dot computer permission, plugin installation, or successful event receipt.

A separate native inspection of the existing dot's profile confirmed that this personal Mac already has access allowed and is online; its cloud computer is ready. No new computer permission is currently needed on that Mac. The new Dori skill invocation and MCP Events connection are still unverified.

Native acceptance requires a bounded request from the user's dot, the corresponding Codex lead job/outcome, and evidence that the actual dot received the result of its local task. Custom MCP Events acceptance separately requires a verified subscription, acknowledged signed delivery, and the resulting Dot task evidence. Record which route was verified; neither route proves the other.

## Native request and status route

Official Dots documentation supports local skills on a separately connected computer. This avoids a public MCP endpoint for submitting a request and reading its result.

Dots can create local Work or Codex tasks and check results of tasks they created on the original computer. Use that supported native task relationship to test result delivery before requiring a public event endpoint. A completed local process alone does not prove the dot received its result.

If access is not already allowed, open the dot's profile in the ChatGPT app, then **Computers**, choose this personal Mac, select **Allow**, and confirm **Allow access**. This is distinct from Codex computer access and Work Sync. Keep the computer online and ChatGPT open. The user must handle a new permission confirmation; do not request it again for an already authorized computer. Do not connect company computers for this personal setup.

Install the local skill from `integrations/dots/SKILL.md` using the app's supported local skill setup. Configure its fixed landed integration path and `DORI_DOTS_CONFIG`; do not copy credentials into the skill.

The integration CLI accepts one JSON object on stdin:

```sh
"$BUN_BIN" /absolute/landed/repo/integrations/dots/cli.ts submit < request.json
"$BUN_BIN" /absolute/landed/repo/integrations/dots/cli.ts status < status.json
```

`request.json` contains `origin_id`, `request_id`, and `prompt`. Both identifiers are required, at most 128 characters each. The prompt is 1–8,000 characters. Repeated identical requests return the same job. Reusing the identity for a changed prompt is rejected.

`status.json` contains `job_id`, using the `id` returned by submit. Returned status includes `state`, `admission`, `summary`, `thread_id`, and `revision`. Admission does not mean completion. A queued request may be waiting for desktop takeback. A held admission must be reconciled against the Dori inbox before any resend; automatic resubmission could duplicate work.

These CLI examples describe host-side operations. Every CLI operation opens the configured private database; submit also invokes the runtime wrapper, and outcome delivery may wake a private socket. Computer access does not prove a sandboxed local task or lead can perform those operations. Use the administrator's confirmed role-bound management tools for any denied boundary. The constrained tool contract must fix the personal instance, configuration, executable and caller role outside model arguments; it must not expose a shell, arbitrary command, home or path. The integration's attachment to that trusted tool path is not yet verified.

## Configuration

Create a private configuration file outside the repository and export its absolute path as `DORI_DOTS_CONFIG`. A native-only configuration is:

```json
{
  "instance": "personal",
  "directory": "/absolute/private/personal-dots",
  "principalFile": "/absolute/private/personal-dots/principals.json",
  "localPrincipal": "PERSONAL_OAUTH_SUBJECT",
  "runtimeHome": "/absolute/private/personal-codex-home",
  "runtimeCommand": ["/bin/sh", "/absolute/landed/repo/scripts/dori-codex.sh"],
  "port": 8766
}
```

These paths are operator configuration, not tool arguments. `runtimeHome` must name the confirmed personal Codex home, and `runtimeCommand` must point to the production Codex wrapper from the landed core revision. Do not point either at the administrator's hc installation. The bridge explicitly pins `DORI_HOME`, `DORI_RUNTIME=codex`, and the current Bun executable for that child, overriding any ambient hc home. It invokes the fixed argv followed by `send`, `lead` and sends the JSON envelope on stdin. It never uses a shell to interpret the prompt.

The CLI and server enforce directory mode `0700` and a restrictive umask; the server also enforces socket mode `0600`. It creates a lock file to prevent duplicate bridge processes. After an unclean shutdown, verify the prior process has exited before removing its stale lock/socket; never run competing bridge processes against one database. Back up the database together with its SQLite WAL according to normal SQLite backup practice. It contains request text and signing secrets and must not be committed or published.

Use the administrator's verified standalone Bun 1.4.4 executable at a durable path for production. Do not depend on a temporary staging binary or silently use another version from PATH. The shared location below was verified on November 13, 2026: it reports version 1.4.4 and its SHA-512 matches the verified staging binary. Check the configured executable on each installation before production startup:

```sh
export BUN_BIN="$HOME/.local/share/dori/toolchains/bun/1.4.4/bin/bun"
"$BUN_BIN" --version
"$BUN_BIN" /absolute/landed/repo/integrations/dots/cli.ts status < status.json
```

## Lead outcome contract

The administrator approved this interface design through the integration lane on November 13, 2026. Live Codex lead use remains a separate verification gate.

`integrations/dots/host-tools.ts` exports `createPersonalTools({configPath, binding})` for the trusted core host. It returns `tools`, `call(name, arguments)`, and `close()`. The factory is not a model tool. The operator fixes its configuration and role before exposing any descriptors:

- A `dot` binding exposes the existing `dori_submit_request` and `dori_job_status` names.
- A `lead` binding includes the trusted caller `thread_id` and an `admittedThreadForJob(job_id)` async callback. It exposes `dori_job_status` and `dori_report_outcome`.

Core must implement that callback from its durable current admission-to-thread mapping, returning the admitted thread or `undefined` for an unadmitted, stale or revoked job. The handler invokes it on every lead status/outcome call and requires a match with the caller's bound thread. New jobs admitted after tool startup remain usable without granting access to every job. Do not implement the lookup using a static startup list, model arguments, or a first-writer ownership claim.

The outcome tool accepts strict JSON containing `job_id`, positive `revision`, `state` (`running`, `decision_needed`, `completed`, or `failed`), and `summary` up to 16,000 characters. It rejects model-supplied `thread_id` and derives that value from trusted binding. It also checks configured principal ownership and any existing durable thread association before applying the revision/outbox transaction. Actual core per-thread attachment and native Dot use of this handler remain unverified.

Every submitted envelope preserves instance, job ID, origin ID, request ID, and prompt. It advertises `dori_report_outcome` and retains a fixed `outcome_protocol.command` argv/configuration path for host-side use. The lead must treat the prompt as user data, preserve the job ID, and use the role-bound tool when attached. The following JSON describes the host-side CLI outcome; omit `thread_id` when calling the tool:

```json
{
  "job_id": "job_SHA256_IDENTIFIER",
  "revision": 1,
  "state": "completed",
  "summary": "The bounded request finished; evidence is recorded in the task.",
  "thread_id": "ACTUAL_CODEX_LEAD_THREAD"
}
```

Read status before writing; use the current revision plus one. States are `queued`, `running`, `decision_needed`, `completed`, and `failed`. An identical revision is idempotent; conflicting or skipped revisions fail. Older revisions cannot overwrite newer state. Terminal jobs cannot return to running.

`cli.ts update` persists the outcome/outbox before waking the bridge through a private Unix socket. If wake fails, the CLI reports a failure after the durable acknowledgement; do not invent a successful callback receipt. Starting the bridge drains persisted deliveries. Native-only outcomes remain available through status without requiring a running MCP server.

## MCP Events route

Request/status tools can also be published through MCP. Custom event push requires the actual supported MCP Events connection. Native task result delivery is a separate mechanism; installing a local skill alone proves neither kind of receipt.

Install the integration's own dependencies:

```sh
cd /absolute/landed/repo/integrations/dots
bun install --frozen-lockfile
bun run typecheck
bun test . --timeout 15000
```

Add an `oauth` object to configuration with `resource`, `issuer`, and `jwksUrl`, all HTTPS. The issuer and JWKS endpoint must share an origin. `principalFile` is a private JSON array of authorized OAuth subjects; remove a subject to revoke bridge access and stop its queued event deliveries. `localPrincipal` must be the same subject used for the personal Dot connection so both routes see the same jobs.

Use an existing OAuth 2.1 authorization server with PKCE S256, resource audience binding, and the exact ChatGPT redirect URI from plugin management. The bridge is the resource server, not an identity provider. It accepts RS256/ES256 JWTs with the exact configured issuer/audience, `dori:jobs` scope, an allowed subject, and a required expiration no more than one hour away. Individual token revocation before expiration belongs to the identity provider; subject removal is checked for every request and event delivery.

Start `bun server.ts` with the private config. It binds only to `127.0.0.1:8766`. Configure an administrator-approved TLS reverse proxy to expose only `/mcp` and `/.well-known/oauth-protected-resource` on the configured HTTPS resource origin. Do not expose the Unix socket or arbitrary local routes. No public endpoint, account, certificate, hosting subscription, or tunnel is created by this integration.

In the user's supported ChatGPT plugin management, register the HTTPS MCP endpoint with OAuth and rescan tools/events. Exact hosting hostname, TLS/reverse proxy, OAuth issuer/client registration, and plugin/account permissions need the administrator's configuration. Do not substitute a static bearer token or assume GitHub login grants these permissions.

The server uses the official TypeScript MCP SDK with Streamable HTTP initialization and the Events draft methods:

- `dori_submit_request` submits the bounded request; `dori_job_status` reads its result.
- `events/list` discovers `dori.job.completed` and `dori.job.decision_needed`, filtered by one owned `job_id`.
- `events/subscribe` verifies a signed, random callback challenge before storing the subscription. IDs are deterministic per principal, callback, event, and job. Refresh replaces signing secrets with a five-minute dual-signature window. Granted expiration is bounded by access-token expiration; null TTL receives a finite grant.
- `events/unsubscribe` is authorized and idempotent. Expired or revoked subscriptions stop delivery.

Callbacks must use HTTPS on port 443. All DNS answers must be public. Each connection pins a newly validated IP while retaining the original Host header and TLS hostname verification. Redirects are never followed. Verification and deliveries use Standard Webhooks HMAC-SHA256 with a `whsec_` base64 key of 24–64 bytes.

One event is sent per request, under 256 KiB, with stable `eventId`, occurrence timestamp, correlation data, and `cursor: null`. This catalog does not support replay. Subscribe before running the bounded task, and use status to recover an outcome missed before subscription or during interruption. The durable outbox retries transient errors at bounded exponential delays, preserves event IDs, and generates fresh signing timestamps. Permanent errors, including 410 and 413, are not retried. Durable delivery receipts record response status and attempt count. No token stream is forwarded.

ChatGPT may batch separately delivered events into a task run. Batching is configured on the subscribed ChatGPT task; it is not a server-side array envelope. A 2xx webhook response proves acknowledgement, not that the Dot completed the requested follow-up.

## Real acceptance procedure

1. Confirm the personal Codex lead is running from the reviewed landed core revision and desktop ownership is known.
2. Have the actual dot submit a harmless bounded request through the connected personal computer or registered MCP tool. Record its origin/request IDs, durable job ID, Codex thread, and admission result.
3. Have the trusted lead report an outcome through its confirmed typed tool. Read the durable status from the Dot-created local task and inspect the dot's actual response to that result. Record local task and lead thread IDs separately. Do not count a host CLI run as native receipt.
4. Retry the identical request and confirm one job; attempt another subject's status and confirm denial. Verify desktop handoff queues or pauses requests rather than steering a user-owned turn.
5. For the custom Events route, ask the dot to monitor both events for the job, stating the desired response. Record real `events/subscribe` input identity, challenge success, granted subscription ID/expiration, without exposing its signing secret. Have the trusted lead emit decision-needed and completion updates, then record signed delivery receipts and inspect the actual Dot task response. Check filtered/unsubscribed events do not wake the task.
6. Stop custom event monitoring and confirm unsubscribe if it was configured. Account for temporary endpoints and stop bounded test processes. If the native route worked without an external endpoint, record that result and leave custom Events explicitly undeployed and unverified.

Until those account-side artifacts exist, report the exact missing account/permission/deployment step and keep the lane waiting rather than claim READY.

Primary protocol references: `https://learn.chatgpt.com/docs/dots`, `https://learn.chatgpt.com/docs/dots/computers-and-apps`, `https://learn.chatgpt.com/docs/dots/tasks-and-memory`, `https://developers.openai.com/plugins/build/mcp-events`, and `https://developers.openai.com/plugins/build/auth`.
