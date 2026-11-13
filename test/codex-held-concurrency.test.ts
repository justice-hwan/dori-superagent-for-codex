import { expect, test } from "bun:test";
import { releaseHeld } from "../src/inbox-held.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test.each([
  { how: "ack" as const, legacy: false },
  { how: "resend" as const, legacy: false },
  { how: "ack" as const, legacy: true },
  { how: "resend" as const, legacy: true },
])("$how preserves READY appended during recovery; legacy=$legacy", async ({ how, legacy }) => {
  const { f, d } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  d.store.setRole("lead", ref);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class DelayedRecovery extends CodexRuntime {
    override async resolveDelivery(ref: SessionRef): Promise<void> {
      entered.resolve();
      await release.promise;
      await super.resolveDelivery(ref);
    }
  }
  const selected = {
    at: d.now(),
    from: "lead",
    text: "held",
    attempt: { at: d.now(), state: "ambiguous" as const },
    ...(legacy ? {} : { deliveryId: crypto.randomUUID() }),
  };
  d.store.enqueue(ref, selected);
  const pending = releaseHeld(
    { ...d, runtimes: new Runtimes("codex", () => new DelayedRecovery(f.root, f.env)) },
    "lead",
    1,
    how,
  );
  await entered.promise;
  d.store.enqueue(ref, { at: d.now() + 1, from: "lane", text: "READY" });
  release.resolve();
  await pending;

  expect(d.store.queued(ref).map((m) => m.text)).toEqual(how === "ack" ? ["READY"] : ["held", "READY"]);
  if (how === "resend") {
    expect(d.store.queued(ref)[0]?.attempt).toBeUndefined();
    expect(d.store.queued(ref)[0]?.deliveryId).toBe(selected.deliveryId);
  }
});
