import { watch, type WatchListener } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRef } from "../types.ts";
import { CONNECT_TIMEOUT_MS, CodexError, object, type CodexConnection, type Notification } from "./protocol.ts";
import { reference, type CodexStore } from "./store.ts";
import { archiveAbandonedAdmission } from "./review.ts";
import { isMissingThreadError } from "./threads.ts";

/** Starts a file watcher; tests substitute one whose stream is not yet live. */
type WatchDirectory = (
  directory: string,
  options: { readonly recursive: boolean },
  listener: WatchListener<string>,
) => { close(): void };

/** Written in each watched directory until its event arrives; neither a record (.json) nor an inbox queue. */
const READY_SENTINEL = ".dori-watch-ready";
const READY_WRITES = 40;

/**
 * A fresh OS file watcher can miss writes made before its stream is live, so readiness is proven by an observed
 * event. The sentinel is rewritten only after a write's share of the deadline passes unseen, at most READY_WRITES
 * times, then removed; a leftover from a crash is simply overwritten. Failing to see it is a typed refusal.
 */
const confirmLive = async (directory: string, live: Promise<void>, milliseconds: number): Promise<void> => {
  const sentinel = join(directory, READY_SENTINEL);
  try {
    for (let write = 0; write < READY_WRITES; write++) {
      await writeFile(sentinel, String(write), { mode: 0o600 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const unseen = new Promise<boolean>((resolve) => {
        timer = setTimeout(resolve, milliseconds / READY_WRITES, false);
      });
      const seen = await Promise.race([live.then(() => true), unseen]);
      clearTimeout(timer);
      if (seen) return;
    }
  } finally {
    await rm(sentinel, { force: true });
  }
  throw new CodexError("transport", `Codex idle watch could not confirm file events in ${directory}`);
};

/** Each thread has its own pending callback; one slow lane never holds up another. */
export const watchIdle = async (
  store: CodexStore,
  connection: CodexConnection,
  callback: (ref: SessionRef) => Promise<void>,
  watchDirectory: WatchDirectory = watch,
  readyMilliseconds = CONNECT_TIMEOUT_MS,
): Promise<() => void> => {
  await store.init();
  const subscribed = new Set<string>();
  // Recovery runs once per abandoned record per watcher; its own failure writes must not schedule another attempt.
  // A record is marked only after an attempt actually ran, so a check that met a live admitter is retried later.
  const attempted = new Set<string>();
  const recover = async (id: string) => {
    if (attempted.has(id)) return;
    const outcome = await archiveAbandonedAdmission(connection, store, id);
    if (outcome.attempted) attempted.add(id);
    if (outcome.failure) report(outcome.failure);
  };
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
          if (entry.admission === "pending") {
            await recover(entry.id);
            return;
          }
          subscribed.add(entry.id);
          try {
            const response = object(await connection.call("thread/resume", { threadId: entry.id, excludeTurns: true }));
            if (object(object(response["thread"])["status"])["type"] === "idle") invoke(entry.id);
          } catch (error) {
            subscribed.delete(entry.id);
            if (!isMissingThreadError(error)) throw error;
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
  const recordsLive = Promise.withResolvers<void>();
  // Until the initial refresh starts, record events add nothing: that refresh runs after both streams are live and
  // reads every record already written.
  let refreshing = false;
  const watcher = watchDirectory(store.directory, { recursive: false }, (_event, filename) => {
    if (filename === READY_SENTINEL) return recordsLive.resolve();
    if (refreshing) void refresh().catch(report);
  });
  const inbox = join(store.root, "inbox");
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const inboxLive = Promise.withResolvers<void>();
  const queues = watchDirectory(inbox, { recursive: true }, (_event, filename) => {
    if (filename === READY_SENTINEL) return inboxLive.resolve();
    if (filename?.startsWith("codex--") && filename.endsWith(".jsonl")) invoke(filename.slice(7, -6));
  });
  try {
    // Both streams must be live before the initial refresh, so nothing written after that refresh can be missed.
    const ready = await Promise.allSettled([
      confirmLive(store.directory, recordsLive.promise, readyMilliseconds),
      confirmLive(inbox, inboxLive.promise, readyMilliseconds),
    ]);
    for (const outcome of ready) if (outcome.status === "rejected") throw outcome.reason;
    refreshing = true;
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
