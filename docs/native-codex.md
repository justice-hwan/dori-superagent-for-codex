# Native Codex harness

The standalone harness can run its lead, duty, lanes and built-in reviewer as native GPT threads. Select `codex` explicitly; it is never detected from PATH. This path uses Bun and an already running compatible native app-server proxy. It does not start the app, change authentication or launch omo, HC or herdr. The terminal-only dori-mode skill launcher remains separate.

Use a dedicated `DORI_HOME` for this instance. Configure its `config.json`:

Native CLI routing resolves a relative home against the operator's working directory before dispatch, so callbacks from another workspace retain the same instance.

```json
{
  "runtime": "codex",
  "codex": {
    "socket": "/absolute/path/to/existing-control.sock",
    "model": "gpt-6.1-sol"
  }
}
```

The socket must be an explicit absolute Unix socket path. `DORI_CODEX_SOCKET` and `DORI_CODEX_MODEL` override the corresponding settings; `DORI_RUNTIME=codex` overrides the runtime selection. The model must be an explicit GPT model. `timeoutMs` bounds native RPC, and `turnTimeoutMs` bounds a one-shot reviewer; both are optional positive millisecond values under `codex`.

`codex.fullAccess` is an optional boolean in this instance's `config.json`. Absent or `false` inherits native policy as before. Only explicit `true` requests `sandbox: "danger-full-access"` and `approvalPolicy: "never"` for this home's native actors. The caller CLI carries the same absolute `DORI_HOME`, so its settings come from that same instance; there is no full-access environment switch or global configuration change.

Full access is not filesystem isolation to the home. It permits native command file access outside the working directory and ordinary network access without per-command escalation. OS permissions and managed native requirements still apply; this setting does not bypass them or establish that a live Unix socket operation succeeded. Local fixtures prove the request/admission contract only.

Creation retains the actual returned sandbox, approval policy, permission-profile provenance and runtime roots privately before input. An explicit full-access request requires the tagged `dangerFullAccess` response and `never` approval; missing, unsupported or contradictory admission holds the created owner without a bootstrap input, fallback or replacement. Public review receipts retain their existing shape.

Requested access mode is bound to the owned actor. Changing this home's opt-in cannot silently reuse or resume existing actors under another mode, including old inherited actors. Use a fresh dedicated home for a new mode. Same-mode owned full-access resume reasserts the supported sandbox/approval parameters and verifies the actual returned policy before further input. Its policy provenance stays private; a failed resume admission remains policy-HELD without resuming or sending again. The prior bootstrap queue acceptance remains recorded.

The wire contract is matched to Codex `rust-v0.167.2`: experimental `/rpc` WebSocket over the configured Unix socket, `thread/start`, metadata-only `thread/read`, `thread/resume`, `thread/queue/add`, `thread/items/list` and `thread/archive`. An incompatible proxy fails closed. There is no default socket discovery, raw command injection, turn steering or alternate model fallback.

Start from the desired working directory, keeping the host in the foreground:

```sh
export DORI_HOME=/absolute/path/to/dori-instance
bun src/cli.ts up
bun src/cli.ts status
```

`up` accepts the lead and duty bootstraps, then hosts the original `runDuty` and `runLoop` in that process. They retain their normal cadence, stop files and lock behavior. Only lead and duty are stored as role refs. Host status reports its live OS guard response and runner states; it never fabricates loop thread refs. `duty stop` / `loop stop` pause their ticks, and the corresponding `resume` commands clear those controls. SIGINT, SIGTERM or a runner failure cancels and joins both runners before releasing the per-home OS guard and original loop leases. An in-flight native operation must settle or reach its deadline before join finishes. Shutdown does not cancel or archive active agents.

The OS binding is lock authority; a PID file is not. A stale socket blocks startup until investigated. Ordinary `status`, `duty status` and `loop status` do not write Dori state or issue native app-server requests. Bun's own cache under the operating-system HOME is separate from Dori state.

Native refs are `codex:<thread UUID>`. Bootstrap creates a thread on one connection, renders and publishes its role/lane and brief with the actual thread/home CLI context, then submits the first input while keeping that connection through acceptance. A positively created caller can register itself, report, become READY or start its first child before the bootstrap ACK; finalizing startup preserves those updates. Creation/caller routing is distinct from the input outcome. Only confirmed-owned accepted targets can be reused or resumed; pending, unknown and HELD targets cannot receive new input or be automatically replayed, replaced or adopted. The CLI prefix is routing context in a trusted home, not unforgeable attestation.

`start`, `send`, `report`, `ready`, `done` and the backlog use the existing harness lifecycle. Native queue acceptance means `DELIVERED` to the queue, not that the model completed. Active agents receive native queued input for idle dispatch. An uncertain submission remains HELD in the existing inbox, including a sender killed after submission began; duty does not resend it. Supported item paging limits reads to four pages of 50 items and marks truncated output.

`done` still requires READY and refuses a busy or unowned thread. Delivery and close share the actor's OS guard and reread the current canonical ownership record before effects. The thread file is immutable creation lookup/provenance; the atomic launch record alone holds current bootstrap/archive outcomes. Native close uses only `thread/archive` on that owned thread. A failed or uncertain archive remains HELD; unsubscribe is never substituted. A successful archive ACK does not prove MCP/daemon shutdown or an atomic check-and-close guarantee.

`review` uses a fresh native GPT reviewer and verifies the completed turn's user-message `clientId` and exact input text hash against its accepted bootstrap before using that turn's agent output. An unrelated same-thread completion cannot supply a verdict. The public exact-head receipt retains its original shape and records the actual selected model in its existing field. Thread, creation-reported provider/model, input identity/hash and verified completion turn remain in private native ownership/provenance, without inferring account type. Native mode explicitly rejects a configured `hooks.reviewCommand`; other runtimes keep their existing override behavior. Merge authority still requires CLEAR at the current head and the existing green checks. Native policy supplies the reviewer's permissions; this path does not add isolation from repository-controlled inputs.

Terminal creation, shell typing, keys, terminal migration and loop-role registration are rejected for native threads. Existing terminal runtimes and their stored refs retain their behavior; a native foreground host requires a dedicated home without foreign terminal roles, lanes or inbox work.

The native integration tests use local Unix WebSocket fixtures and real CLI/test processes. They do not validate a live app, paid model execution, GUI visibility or external daemon cleanup.
