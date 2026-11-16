import { expect, test } from "bun:test";
import type { WatchListener } from "node:fs";
import { join } from "node:path";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection, object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test("duty explicitly defers while inbox settlement owns admission", async () => {
  const { f, d } = await harnessFixture();
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const started = object(await connection.call("thread/start", { cwd: f.spec.cwd }));
  const id = object(started["thread"])["id"];
  if (typeof id !== "string") throw new Error("Missing fixture identity");
  const ref = { runtime: "codex", id } as const;
  const store = new CodexStore(f.root);
  await store.save({
    id,
    closed: false,
    spec: { ...f.spec, role: "lead", env: {} },
    envelope: { version: 1, endpoint: connection.address },
  });
  d.store.setRole("lead", ref);
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Error("Missing actual inbox reservation");
  try {
    const before = f.calls.length;
    expect(await new MessageController(d, store, connection).reconcile(ref)).toBe("inbox-busy");
    expect(f.calls.slice(before)).toEqual([]);
  } finally {
    release();
  }
});

for (const moment of ["before", "during", "after", "ordinary"] as const) {
  test(`inbox release wakes deferred duty: ${moment}`, async () => {
    const { f } = await harnessFixture();
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    const started = object(await connection.call("thread/start", { cwd: f.spec.cwd }));
    const id = object(started["thread"])["id"];
    if (typeof id !== "string") throw new Error("Missing fixture identity");
    const store = new CodexStore(f.root);
    await store.save({
      id,
      closed: false,
      spec: { ...f.spec, role: "lead", env: {} },
      envelope: { version: 1, endpoint: connection.address },
    });
    const listeners = new Map<string, WatchListener<string>>();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let reads = 0,
      callbacks = 0;
    const owned = store.owned.bind(store);
    store.owned = async (...args) => {
      reads++;
      if (moment === "before" && reads === 2)
        listeners.get(join(f.root, "inbox"))?.("rename", `codex--${id}.jsonl.lock`);
      return owned(...args);
    };
    const stop = await watchIdle(
      store,
      connection,
      async () => {
        callbacks++;
        if (callbacks === 1) {
          entered.resolve();
          await finish.promise;
          return moment === "ordinary" ? undefined : "inbox-busy";
        }
      },
      (directory, _options, listener) => {
        listeners.set(directory, listener);
        queueMicrotask(() => listener("change", ".dori-watch-ready"));
        return { close() {} };
      },
    );
    f.cleanup.push(stop);
    await entered.promise;
    const before = reads;
    const release = () => listeners.get(join(f.root, "inbox"))?.("rename", `codex--${id}.jsonl.lock`);
    if (moment === "during" || moment === "ordinary") release();
    finish.resolve();
    // A real protocol round trip drains the callback promise chain without a timer or retry.
    await connection.call("thread/read", { threadId: id, includeTurns: false });
    if (moment === "after") release();
    expect(reads).toBe(before + (moment === "ordinary" ? 0 : 1));
  });
}
