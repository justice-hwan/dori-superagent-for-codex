import type { CreateSpec, SessionRef } from "../types.ts";
import { disabledConfiguredMcpServers } from "./mcp-config.ts";
import { type CodexConnection, CodexError, object, text } from "./protocol.ts";
import { admitThread } from "./review.ts";
import { type CodexStore, reference } from "./store.ts";
import { startParams, type Environment } from "./threads.ts";
import { messageInstructions } from "./message-instructions.ts";

export async function createManaged(
  store: CodexStore,
  connection: CodexConnection,
  spec: CreateSpec,
  env: Environment,
): Promise<SessionRef> {
  if (spec.role === "duty-loop" || spec.role === "hourly-loop") {
    const entry = { id: `worker-${crypto.randomUUID()}`, spec, closed: false };
    await store.save(entry);
    return reference(entry);
  }
  if (env["DORI_CODEX_SANDBOX"] && env["DORI_CODEX_SANDBOX"] !== "workspace-write")
    throw new CodexError("unsupported", "Managed Codex roles require workspace-write");
  const hostLabel = env["DORI_CODEX_HOST_LABEL"];
  if (hostLabel !== undefined && (!hostLabel.trim() || hostLabel !== hostLabel.trim()))
    throw new CodexError("unsupported", "DORI_CODEX_HOST_LABEL must be a nonempty operator label");
  const milliseconds = Number(env["DORI_CODEX_REVIEW_TIMEOUT_MS"] || 120000);
  if (!Number.isFinite(milliseconds) || milliseconds < 1)
    throw new CodexError("unsupported", "Admission timeout must be positive");
  const params = startParams(store.root, spec, env);
  const disabled = await disabledConfiguredMcpServers(connection, spec.cwd, "dori");
  const response = object(
    await connection.call("thread/start", {
      ...params,
      developerInstructions: await messageInstructions(store.root, spec),
      config: {
        ...object(params["config"]),
        mcp_servers: disabled,
        sandbox_workspace_write: { writable_roots: [], exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      },
    }),
  );
  const id = text(object(response["thread"])["id"]);
  const envelope = {
    version: 1 as const,
    endpoint: connection.address,
    ...(hostLabel === undefined ? {} : { hostLabel }),
  };
  await admitThread(
    connection,
    store,
    { id, spec, closed: false, admission: "pending", envelope },
    new Set(Object.keys(disabled)),
    milliseconds,
  );
  await connection.call("thread/name/set", { threadId: id, name: `Dori ${spec.role}: ${spec.name}` });
  return reference({ id, spec, closed: false });
}
