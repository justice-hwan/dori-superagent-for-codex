import { expect, test } from "bun:test";
import type { WatchListener } from "node:fs";
import { join } from "node:path";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { takeManagedSubmit } from "../src/runtime/codex/submit-lock.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

for (const resource of ["inbox", "submit"] as const) {
  for (const moment of ["before", "during", "after", "ordinary"] as const) {
    test(`target ${resource} release routes to deferred source: ${moment}`, async () => {
      const { f, d } = await harnessFixture();
      const source = await f.rt.create({ ...f.spec, role: "lead", env: {} });
      const target = await f.rt.create({
        ...f.spec,
        role: "lane",
        env: { DORI_LANE: "audit" },
      });
      const store = new CodexStore(f.root);
      const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
      const listeners = new Map<string, WatchListener<string>>();
      const release = resource === "inbox" ? d.store.lockInbox(target, d.now()) : takeManagedSubmit(store, target.id);
      if (!release) throw new Error("Missing target reservation");
      const event = () => {
        release();
        const directory = resource === "inbox" ? join(f.root, "inbox") : store.directory;
        const name = resource === "inbox" ? `codex--${target.id}.jsonl.lock` : `${target.id}.json.submit-released`;
        listeners.get(directory)?.("rename", name);
      };
      const entered = Promise.withResolvers<void>(),
        finish = Promise.withResolvers<void>();
      let reads = 0,
        callbacks = 0;
      const owned = store.owned.bind(store);
      store.owned = async (...args) => {
        if (args[0].id === source.id) {
          reads++;
          if (moment === "before" && reads === 2) event();
        }
        return owned(...args);
      };
      const stop = await watchIdle(
        store,
        connection,
        async (ref) => {
          if (ref.id !== source.id) return;
          callbacks++;
          if (callbacks === 1) {
            entered.resolve();
            await finish.promise;
            if (moment !== "ordinary") return { kind: "target-busy", resource, id: target.id };
          }
        },
        (directory, _options, listener) => {
          listeners.set(directory, listener);
          queueMicrotask(() => listener("change", ".dori-watch-ready"));
          return { close() {} };
        },
      );
      f.cleanup.push(stop, release);
      await entered.promise;
      const before = reads;
      // Old metadata removal is not a post-submit-release hint.
      if (resource === "submit") listeners.get(store.directory)?.("rename", `${target.id}.json.submit-lock`);
      expect(reads).toBe(before);
      if (moment === "during" || moment === "ordinary") event();
      finish.resolve();
      await connection.call("thread/read", {
        threadId: source.id,
        includeTurns: false,
      });
      if (moment === "after") event();
      expect(reads).toBe(before + (moment === "ordinary" ? 0 : 1));
      stop();
    });
  }
}
