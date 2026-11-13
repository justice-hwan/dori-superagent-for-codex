import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRef } from "../types.ts";
import { CodexError, object, type CodexConnection, type Notification } from "./protocol.ts";
import { reference, type CodexStore } from "./store.ts";

/** Each thread has its own pending callback; one slow lane never holds up another. */
export const watchIdle = async (
  store: CodexStore,
  connection: CodexConnection,
  callback: (ref: SessionRef) => Promise<void>,
): Promise<() => void> => {
  await store.init();
  const subscribed = new Set<string>();
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  let stopped = false;
  const report = (error: unknown) => process.stderr.write(`dori: Codex idle watch failed: ${String(error)}\n`);
  const invoke = (id: string) => {
    if (stopped || !subscribed.has(id)) return;
    if (running.has(id)) {
      rerun.add(id);
      return;
    }
    const pending = store.owned({ runtime: "codex", id }).then((entry) => callback(reference(entry)));
    running.set(id, pending);
    void pending.catch(report).finally(() => {
      running.delete(id);
      if (rerun.delete(id)) invoke(id);
    });
  };
  const refresh = async () => {
    const entries = await store.entries();
    await Promise.all(
      entries
        .filter((entry) => !entry.id.startsWith("worker-"))
        .map(async (entry) => {
          if (stopped || subscribed.has(entry.id)) return;
          subscribed.add(entry.id);
          try {
            const response = object(await connection.call("thread/resume", { threadId: entry.id, excludeTurns: true }));
            if (object(object(response["thread"])["status"])["type"] === "idle") invoke(entry.id);
          } catch (error) {
            subscribed.delete(entry.id);
            throw error;
          }
        }),
    );
  };
  const listener = (event: Notification) => {
    const id = event.params["threadId"];
    if (typeof id !== "string" || !subscribed.has(id) || stopped) return;
    const idle =
      event.method === "turn/completed" ||
      (event.method === "thread/status/changed" && object(event.params["status"])["type"] === "idle");
    if (idle) invoke(id);
  };
  const disconnected = () => {
    if (stopped) return;
    subscribed.clear();
    // Rejoining subscriptions is safe. Never replay turn/start or any ordinary RPC.
    void refresh().catch((error: unknown) => {
      if (stopped) return;
      queueMicrotask(() => {
        throw new CodexError("transport", `Codex idle subscription lost; restart duty worker: ${String(error)}`);
      });
    });
  };
  connection.listeners.add(listener);
  connection.disconnections.add(disconnected);
  const watcher = watch(store.directory, () => {
    void refresh().catch(report);
  });
  const inbox = join(store.root, "inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const queues = watch(inbox, { recursive: true }, (_event, filename) => {
    if (filename?.startsWith("codex--") && filename.endsWith(".jsonl")) invoke(filename.slice(7, -6));
  });
  try {
    await refresh();
  } catch (error) {
    watcher.close();
    queues.close();
    connection.listeners.delete(listener);
    connection.disconnections.delete(disconnected);
    throw error;
  }
  return () => {
    stopped = true;
    watcher.close();
    queues.close();
    connection.listeners.delete(listener);
    connection.disconnections.delete(disconnected);
    connection.disconnect();
  };
};
