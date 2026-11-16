import { existsSync, watch, type WatchListener } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionRef } from "../types.ts";
import { CONNECT_TIMEOUT_MS, CodexError, object, type CodexConnection, type Notification } from "./protocol.ts";
import { assertEndpoint, reference, type CodexStore } from "./store.ts";
import { archiveAbandonedAdmission } from "./review.ts";
import { isMissingThreadError } from "./threads.ts";
import { unseenTurns } from "./message-schema.ts";
import type { ReconcileOutcome } from "./messages.ts";

type WatchDirectory = (
  directory: string,
  options: { readonly recursive: boolean },
  listener: WatchListener<string>,
) => { close(): void };

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
  callback: (
    ref: SessionRef,
    event?: Notification,
    historical?: ReadonlySet<string>,
  ) => Promise<void> | Promise<ReconcileOutcome>,
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
  const rerun = new Map<string, Notification | undefined>();
  const deferred = new Map<string, string>();
  const releases = new Map<string, number>();
  const historical = new Map<string, ReadonlySet<string>>();
  let sequence = 0;
  let stopped = false;
  const report = (error: unknown) => process.stderr.write(`dori: Codex idle watch failed: ${String(error)}\n`);
  const invoke = (id: string, event?: Notification) => {
    if (stopped || !subscribed.has(id)) return;
    if (running.has(id)) {
      rerun.set(id, event);
      return;
    }
    deferred.delete(id);
    const epoch = sequence;
    const pending = store
      .owned({ runtime: "codex", id })
      .then(async (entry) =>
        entry.desktopOwned ? undefined : await callback(reference(entry), event, historical.get(id)),
      )
      .then((outcome) => {
        const resource =
          outcome === "inbox-busy"
            ? `inbox:${id}`
            : outcome?.kind === "target-busy"
              ? `${outcome.resource}:${outcome.id}`
              : undefined;
        if (!resource) return;
        if ((releases.get(resource) ?? 0) > epoch) rerun.set(id, event);
        else deferred.set(id, resource);
      });
    running.set(id, pending);
    void pending.catch(report).finally(() => {
      running.delete(id);
      if (rerun.has(id)) {
        const next = rerun.get(id);
        rerun.delete(id);
        invoke(id, next);
      }
    });
  };
  const released = (id: string, resource: "inbox" | "submit") => {
    const key = `${resource}:${id}`;
    releases.set(key, ++sequence);
    for (const [source, target] of deferred) if (target === key) invoke(source);
  };
  const refresh = async () => {
    const entries = await store.entries();
    await Promise.all(
      entries
        .filter((entry) => !entry.id.startsWith("worker-"))
        .map(async (entry) => {
          if (stopped) return;
          assertEndpoint(entry, connection.address);
          if (entry.admission === "pending") {
            await recover(entry.id);
            return;
          }
          if (entry.desktopOwned) return;
          if (subscribed.has(entry.id)) {
            const response = object(
              await connection.call("thread/read", {
                threadId: entry.id,
                includeTurns: false,
              }),
            );
            if (object(object(response["thread"])["status"])["type"] === "idle") invoke(entry.id);
            return;
          }
          try {
            if (!historical.has(entry.id))
              historical.set(
                entry.id,
                new Set((await unseenTurns(connection, entry.id, () => false)).map((turn) => String(turn["id"]))),
              );
            subscribed.add(entry.id);
            const response = object(
              await connection.call("thread/resume", {
                threadId: entry.id,
                excludeTurns: true,
              }),
            );
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
    if (idle) invoke(id, event);
  };
  const disconnected = () => {
    if (stopped) return;
    subscribed.clear();
    if (!refreshing) return;
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
  const recordsLive = Promise.withResolvers<void>(),
    inboxLive = Promise.withResolvers<void>();
  const rolesLive = Promise.withResolvers<void>(),
    lanesLive = Promise.withResolvers<void>();
  let refreshing = false;
  const watchers: { close(): void }[] = [];
  const inbox = join(store.root, "inbox"),
    lanes = join(store.root, "lanes");
  try {
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await mkdir(lanes, { recursive: true, mode: 0o700 });
    watchers.push(
      watchDirectory(store.directory, { recursive: false }, (_event, filename) => {
        if (filename === READY_SENTINEL) return recordsLive.resolve();
        if (filename?.endsWith(".json.submit-released")) released(filename.slice(0, -21), "submit");
        if (refreshing && filename?.endsWith(".json.submit-lock") && !existsSync(join(store.directory, filename)))
          void store
            .owned({ runtime: "codex", id: filename.slice(0, -17) }, true)
            .then((entry) => (entry.admission === "pending" && !entry.closed ? refresh() : undefined))
            .catch(report);
        if (refreshing && filename?.endsWith(".json")) void refresh().catch(report);
      }),
    );
    watchers.push(
      watchDirectory(inbox, { recursive: true }, (_event, filename) => {
        if (filename === READY_SENTINEL) return inboxLive.resolve();
        if (filename?.startsWith("codex--") && filename.endsWith(".jsonl.lock") && !existsSync(join(inbox, filename))) {
          released(filename.slice(7, -11), "inbox");
        }
        if (filename?.startsWith("codex--") && filename.endsWith(".jsonl")) invoke(filename.slice(7, -6));
      }),
    );
    const registration = () => {
      if (refreshing) void refresh().catch(report);
    };
    watchers.push(
      watchDirectory(store.root, { recursive: true }, (_event, filename) => {
        if (filename === READY_SENTINEL) return rolesLive.resolve();
        if (filename === "roles.json" || filename === join("duty", "stop")) registration();
      }),
    );
    watchers.push(
      watchDirectory(lanes, { recursive: false }, (_event, filename) => {
        if (filename === READY_SENTINEL) return lanesLive.resolve();
        if (filename?.endsWith(".json")) registration();
      }),
    );
    const ready = await Promise.allSettled([
      confirmLive(store.directory, recordsLive.promise, readyMilliseconds),
      confirmLive(inbox, inboxLive.promise, readyMilliseconds),
      confirmLive(store.root, rolesLive.promise, readyMilliseconds),
      confirmLive(lanes, lanesLive.promise, readyMilliseconds),
    ]);
    for (const outcome of ready) if (outcome.status === "rejected") throw outcome.reason;
    refreshing = true;
    await refresh();
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    connection.listeners.delete(listener);
    connection.disconnections.delete(disconnected);
    throw error;
  }
  return () => {
    stopped = true;
    for (const watcher of watchers) watcher.close();
    connection.listeners.delete(listener);
    connection.disconnections.delete(disconnected);
    connection.disconnect();
  };
};
