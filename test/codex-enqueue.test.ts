import { expect, test } from "bun:test";
import { flushInbox } from "../src/inbox.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import type { Probe, SessionRef } from "../src/runtime/types.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test("native enqueue persists identities before delivery and preserves supplied identities", async () => {
  const { f } = await harnessFixture();
  const store = new Store(f.root);
  const ref: SessionRef = { runtime: "codex", id: crypto.randomUUID() };
  store.enqueue(ref, { at: 1, from: "test", text: "first" });
  const first = store.queued(ref)[0]?.deliveryId;
  expect(first).toBeString();
  store.enqueue(ref, { at: 2, from: "test", text: "second", deliveryId: "already-stable" });
  expect(store.queued(ref).map((message) => message.deliveryId)).toEqual([first, "already-stable"]);
});

test("busy native flush retains enqueue identities and a concurrently appended READY", async () => {
  const { f, d } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  d.store.enqueue(ref, { at: 1, from: "test", text: "report" });
  const identity = d.store.queued(ref)[0]?.deliveryId;
  expect(identity).toBeString();
  class BusyRuntime extends CodexRuntime {
    override async probe(): Promise<Probe> {
      d.store.enqueue(ref, { at: 2, from: "lane", text: "READY" });
      return { status: "working", shellInFront: false };
    }
  }
  const runtime = new BusyRuntime(f.root, f.env);
  expect(await flushInbox({ ...d, runtimes: new Runtimes("codex", () => runtime) }, ref)).toBe("queued");
  const queue = d.store.queued(ref);
  expect(queue.map((message) => message.text)).toEqual(["report", "READY"]);
  expect(queue[0]?.deliveryId).toBe(identity);
  expect(queue[1]?.deliveryId).toBeString();
  expect(new Set(queue.map((message) => message.deliveryId)).size).toBe(2);
  expect(f.calls).not.toContain("turn/start");
});
