import { expect, spyOn, test } from "bun:test";
import { flushInbox, send } from "../src/inbox.ts";
import { releaseHeld } from "../src/inbox-held.ts";
import { done, ready } from "../src/lanes.ts";
import { Store } from "../src/store.ts";
import type { QueuedMessage } from "../src/store-types.ts";
import { acceptedHeld, readyLane } from "./fixtures/ready-lane.ts";

test("confirmed resend recovery invalidates READY after interrupted lane update", async () => {
  const { f, d, ref } = await acceptedHeld();
  const acknowledgement = spyOn(f.rt, "resolveDelivery").mockRejectedValueOnce(new Error("ack interrupted"));
  try {
    await expect(releaseHeld(d, "followup", 1, "ack")).rejects.toThrow(/ack interrupted/);
  } finally {
    acknowledgement.mockRestore();
  }
  await ready(d, "followup", "before resend", ["before.json"]);
  const ids = d.store.queued(ref).map((message) => {
    if (message.deliveryId === undefined) throw new Error("Missing queued native message identity");
    return message.deliveryId;
  });
  await releaseHeld(d, "followup", 1, "resend");
  let restore: (() => void) | undefined;
  f.onAdmission((id) => {
    if (id !== ref.id || restore) return;
    const interrupted = spyOn(d.store, "saveLane").mockImplementationOnce(() => {
      throw new Error("lane invalidation interrupted");
    });
    restore = () => interrupted.mockRestore();
  });
  try {
    await expect(flushInbox(d, ref)).rejects.toThrow(/lane invalidation interrupted/);
  } finally {
    restore?.();
  }
  expect(f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage")).toHaveLength(2);
  expect((await f.rt.confirmedDelivery(ref))?.messageIds).toEqual(ids);
  expect(d.store.lane("followup")?.final?.text).toBe("before resend");
  f.finish(ref.id, "resend completed without another READY");
  const recovered = { ...d, store: new Store(d.store.root) };

  expect(await flushInbox(recovered, ref)).toBe("delivered");

  expect(recovered.store.queued(ref)).toEqual([]);
  await expect(done(recovered, "followup")).rejects.toThrow(/not ready/);
  expect(recovered.store.lane("followup")?.final).toBeUndefined();
});

test("older held work cannot erase fresh READY during newer resend receipt recovery", async () => {
  const { f, d, ref } = await acceptedHeld(2);
  await releaseHeld(d, "followup", 1, "resend");
  const interrupted = spyOn(f.rt, "acknowledgeDelivery").mockRejectedValueOnce(
    new Error("resend receipt acknowledgement interrupted"),
  );
  try {
    await expect(flushInbox(d, ref)).rejects.toThrow(/receipt acknowledgement interrupted/);
  } finally {
    interrupted.mockRestore();
  }
  expect(f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage")).toHaveLength(2);
  expect(await f.rt.confirmedDelivery(ref)).toBeDefined();
  expect(d.store.queued(ref).map((message) => message.text)).toEqual(["task-2"]);
  f.finish(ref.id, "new resend and old held work completed");
  await ready(d, "followup", "fresh resend result", ["resend.json"]);
  expect(d.store.lane("followup")?.final?.text).toBe("fresh resend result");
  const recovered = { ...d, store: new Store(d.store.root) };

  expect(await flushInbox(recovered, ref)).toBe("held");

  expect(recovered.store.lane("followup")?.final?.text).toBe("fresh resend result");
  await releaseHeld(recovered, "followup", 1, "ack");
  await done(recovered, "followup");
  expect(recovered.store.lane("followup")?.status).toBe("done");
});

test("submission reservation is durable before native acceptance despite an interrupted queue write", async () => {
  const { f, d, ref } = await readyLane();
  d.store.enqueue(ref, { at: d.now(), from: "lead", text: "reserve before accepting" });
  const ids = d.store.queued(ref).map((message) => {
    if (message.deliveryId === undefined) throw new Error("Missing queued native message identity");
    return message.deliveryId;
  });
  const interrupted = spyOn(d.store, "updateInbox").mockImplementationOnce(() => {
    throw new Error("reservation write interrupted");
  });
  try {
    await expect(flushInbox(d, ref)).rejects.toThrow(/reservation write interrupted/);
  } finally {
    interrupted.mockRestore();
  }
  expect(f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage")).toEqual([]);
  let observed: QueuedMessage | undefined;
  f.onAdmission((id) => {
    if (id === ref.id) observed = new Store(d.store.root).queued(ref)[0];
  });
  const acknowledgement = spyOn(f.rt, "acknowledgeDelivery").mockRejectedValueOnce(new Error("receipt held"));
  try {
    await expect(flushInbox(d, ref)).rejects.toThrow(/receipt held/);
  } finally {
    acknowledgement.mockRestore();
  }
  expect(f.threads.get(ref.id)?.items.filter((item) => item["type"] === "userMessage")).toHaveLength(1);
  const confirmed = await f.rt.confirmedDelivery(ref);
  expect(confirmed).toBeDefined();
  expect(observed?.submission?.id).toBe(confirmed?.id);
  expect(observed?.deliveryId).toBe(ids[0]);
  expect(confirmed?.messageIds).toEqual(ids);
  f.finish(ref.id, "reserved turn completed");
});

test("a stale lane save cannot resurrect completion after a confirmed admission", async () => {
  const { f, d, ref } = await readyLane();
  const stale = d.store.lane("followup");
  if (!stale) throw new Error("Missing fixture lane");
  expect(await send(d, "followup", "actual new admission", "lead")).toBe("DELIVERED");
  f.finish(ref.id, "new work completed without READY");
  expect(await f.rt.confirmedDelivery(ref)).toBeUndefined();
  d.store.saveLane(stale);

  await expect(done(d, "followup")).rejects.toThrow(/not ready/);

  expect(d.store.lane("followup")?.final).toBeUndefined();
  expect(d.store.queued(ref)).toEqual([]);
});
