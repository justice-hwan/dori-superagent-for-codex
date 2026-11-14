import type { CreateSpec } from "../types.ts";
import { array, type CodexConnection, CodexError, object, text } from "./protocol.ts";
import type { CodexStore } from "./store.ts";
import { disabledConfiguredMcpServers } from "./bridge-install.ts";
import { readThread, startParams, type Environment } from "./threads.ts";

type ReviewResult = { readonly stdout: string; readonly code: number; readonly stderr: string };

/** A review owns a fresh read-only thread and only interrupts the turn it started. */
export const runReview = async (
  store: CodexStore,
  connection: CodexConnection,
  env: Environment,
  prompt: string,
  model?: string,
  signal?: AbortSignal,
): Promise<ReviewResult> => {
  if (signal?.aborted) return { stdout: "", code: 1, stderr: "Codex review cancelled" };
  const milliseconds = Number(env["DORI_CODEX_REVIEW_TIMEOUT_MS"] || 120_000);
  if (!Number.isFinite(milliseconds) || milliseconds < 1)
    throw new CodexError("unsupported", "DORI_CODEX_REVIEW_TIMEOUT_MS must be positive");
  const spec: CreateSpec = {
    name: "review",
    role: "lane",
    cwd: env["DORI_CODEX_WORKSPACE"] || process.cwd(),
    env: {},
    container: "tab",
  };
  const params = startParams(store.root, spec, env);
  const response = object(
    await connection.call("thread/start", {
      ...params,
      sandbox: "read-only",
      config: { ...object(params["config"]), mcp_servers: await disabledConfiguredMcpServers(connection, spec.cwd) },
      ...(model ? { model } : {}),
    }),
  );
  const id = text(object(response["thread"])["id"]);
  const entry = { id, spec, closed: false };
  await store.save(entry);
  const completed = Promise.withResolvers<Record<string, unknown>>();
  let turnId: string | undefined;
  let finished = false;
  let closeable = false;
  const messageId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const listener = (event: { readonly method: string; readonly params: Record<string, unknown> }) => {
    if (event.method !== "turn/completed" || event.params["threadId"] !== id) return;
    const turn = object(event.params["turn"]);
    if (!turnId || turn["id"] === turnId) {
      finished = true;
      completed.resolve(turn);
    }
  };
  connection.listeners.add(listener);
  try {
    await store.save({ ...entry, uncertain: "Native review submission may have been accepted" });
    const started = object(
      await connection.call("turn/start", {
        threadId: id,
        clientUserMessageId: messageId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }),
    );
    turnId = text(object(started["turn"])["id"]);
    await store.save(entry);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CodexError("unsupported", "Codex review timed out")), milliseconds);
      cancel = () => reject(new CodexError("unsupported", "Codex review cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    const turn = await Promise.race([completed.promise, timeout]);
    closeable = true;
    return {
      stdout: await readThread(connection, id, Number.MAX_SAFE_INTEGER, true),
      code: turn["status"] === "completed" ? 0 : 1,
      stderr: turn["error"] ? JSON.stringify(turn["error"]) : "",
    };
  } catch (error) {
    if (!(error instanceof CodexError && error.kind === "remote")) {
      await connection.call("thread/resume", { threadId: id, excludeTurns: true });
      const page = object(
        await connection.call("thread/turns/list", {
          threadId: id,
          sortDirection: "desc",
          limit: 1,
          itemsView: "full",
        }),
      );
      for (const value of array(page["data"])) {
        const turn = object(value);
        if (
          turnId ? turn["id"] === turnId : array(turn["items"]).some((item) => object(item)["clientId"] === messageId)
        ) {
          turnId = text(turn["id"]);
          finished = finished || turn["status"] !== "inProgress";
        }
      }
      if (!turnId)
        throw new CodexError("uncertain", "Review admission could not be resolved; owned thread remains recoverable");
    }
    if (turnId && !finished) {
      await connection.call("turn/interrupt", { threadId: id, turnId });
      await Promise.race([
        completed.promise,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new CodexError("uncertain", "Review cancellation was not confirmed")),
            5_000,
          );
        }),
      ]);
    }
    closeable = true;
    return { stdout: "", code: 1, stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    if (cancel) signal?.removeEventListener("abort", cancel);
    connection.listeners.delete(listener);
    if (closeable) {
      await connection.call("thread/unsubscribe", { threadId: id });
      await store.save({ ...entry, closed: true });
    } else await store.save({ ...entry, uncertain: "Review cleanup is uncertain; inspect owned thread history" });
  }
};
