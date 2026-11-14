import { expect, test } from "bun:test";
import type { WatchListener } from "node:fs";
import { flushInbox } from "../src/inbox.ts";
import { CodexConnection, CodexError } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

// Observation only: all enumeration still reads the real on-disk records.
class ObservedStore extends CodexStore {
  enumerations = 0;
  override entries() {
    this.enumerations++;
    return super.entries();
  }
}

test.each(["live", "silent"] as const)("reconnect during a %s handshake cannot bypass readiness", async (outcome) => {
  const { f, d } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  await connection.call("thread/read", { threadId: ref.id });
  const store = new ObservedStore(f.root);
  const watchers = Promise.withResolvers<void>();
  const listeners: WatchListener<string>[] = [];
  let closed = 0;
  const fakeWatch = (
    _directory: string,
    _options: { readonly recursive: boolean },
    listener: WatchListener<string>,
  ) => {
    listeners.push(listener);
    if (listeners.length === 2) watchers.resolve();
    return {
      close: () => {
        closed++;
      },
    };
  };
  const callbackFinished = Promise.withResolvers<void>();
  let callbacks = 0;
  const startup = watchIdle(
    store,
    connection,
    async (target) => {
      callbacks++;
      await flushInbox(d, target);
      callbackFinished.resolve();
    },
    fakeWatch,
    outcome === "silent" ? 100 : undefined,
  ).then(
    (stop) => ({ stop, error: undefined }),
    (error: unknown) => ({ stop: undefined, error }),
  );
  await watchers.promise;
  const disconnected = Promise.withResolvers<void>();
  // Registered after watchIdle: its handler has run when this observer resolves.
  connection.disconnections.add(disconnected.resolve);
  f.dropClients();
  await disconnected.promise;
  connection.disconnections.delete(disconnected.resolve);
  // If reconnect launched a premature refresh, finish its empty-queue callback
  // before writing the message. Correct code launches none until readiness.
  if (store.enumerations !== 0) await callbackFinished.promise;
  const beforeReady = callbacks;
  d.store.enqueue(ref, { at: d.now(), from: "operator", text: "queued during watcher handshake" });
  if (outcome === "live") {
    for (const listener of listeners) listener("change", ".dori-watch-ready");
  }
  const result = await startup;
  f.cleanup.push(() => result.stop?.());
  if (outcome === "live" && callbacks === 0) await callbackFinished.promise;
  const observed = {
    beforeReady,
    queued: d.store.queued(ref).map((message) => message.text),
    messages: f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage").length,
    failure: result.error instanceof CodexError ? result.error.kind : result.error,
    closed,
  };
  console.info("RECONNECT_HANDSHAKE", outcome, observed);
  expect(observed).toEqual(
    outcome === "live"
      ? { beforeReady: 0, queued: [], messages: 1, failure: undefined, closed: 0 }
      : { beforeReady: 0, queued: ["queued during watcher handshake"], messages: 0, failure: "transport", closed: 2 },
  );
});
