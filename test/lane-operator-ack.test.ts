import { expect, spyOn, test } from "bun:test";
import { flushInbox, send } from "../src/inbox.ts";
import { releaseHeld } from "../src/inbox-held.ts";
import { done, ready } from "../src/lanes.ts";
import { acceptedHeld, readyLane } from "./fixtures/ready-lane.ts";

test("operator ack of accepted disconnected followup requires fresh READY", async () => {
  const { f, d, ref } = await acceptedHeld();

  await releaseHeld(d, "followup", 1, "ack");

  expect(d.store.queued(ref)).toEqual([]);
  await expect(done(d, "followup")).rejects.toThrow(/not ready/);
  expect(d.store.lane("followup")?.final).toBeUndefined();
  expect((await f.rt.probe(ref)).status).toBe("idle");
});

test("fresh READY before operator ack survives ambiguity reconciliation", async () => {
  const { d, ref } = await acceptedHeld();
  await ready(d, "followup", "fresh result", ["fresh.json"]);

  await releaseHeld(d, "followup", 1, "ack");
  await done(d, "followup");

  expect(d.store.lane("followup")?.final?.text).toBe("fresh result");
  expect(d.store.lane("followup")?.status).toBe("done");
  expect(d.store.queued(ref)).toEqual([]);
});

test("selected old batch ack preserves newer READY through confirmed receipt recovery", async () => {
  const { f, d, ref } = await acceptedHeld(2);
  await releaseHeld(d, "followup", 2, "ack");
  expect(d.store.queued(ref).map((message) => message.text)).toEqual(["task-1"]);
  await ready(d, "followup", "first batch complete", ["first.json"]);
  const interrupted = spyOn(f.rt, "acknowledgeDelivery").mockImplementationOnce(async () => {
    throw new Error("newer receipt acknowledgement interrupted");
  });
  try {
    await expect(send(d, "followup", "newer task", "lead")).rejects.toThrow(/acknowledgement interrupted/);
  } finally {
    interrupted.mockRestore();
  }
  f.finish(ref.id, "newer task complete");
  await ready(d, "followup", "newer result", ["newer.json"]);

  await releaseHeld(d, "followup", 1, "ack");
  await done(d, "followup");
  await flushInbox(d, ref);

  expect(d.store.lane("followup")?.final?.text).toBe("newer result");
  expect(d.store.lane("followup")?.status).toBe("done");
  expect(d.store.queued(ref)).toEqual([]);
  expect(await f.rt.confirmedDelivery(ref)).toBeUndefined();
});

test.each(["queue", "uncertainty"] as const)(
  "fresh READY survives operator ack interrupted at %s recovery",
  async (gap) => {
    const { f, d, ref } = await acceptedHeld();
    const interrupted =
      gap === "queue"
        ? spyOn(d.store, "updateInbox").mockImplementationOnce(() => {
            throw new Error("operator acknowledgement interrupted");
          })
        : spyOn(f.rt, "resolveDelivery").mockImplementationOnce(async () => {
            throw new Error("operator acknowledgement interrupted");
          });
    try {
      await expect(releaseHeld(d, "followup", 1, "ack")).rejects.toThrow(/interrupted/);
    } finally {
      interrupted.mockRestore();
    }
    expect(d.store.queued(ref).map((message) => message.text)).toEqual(["task-1"]);
    await ready(d, "followup", "fresh after interruption", ["fresh.json"]);

    await releaseHeld(d, "followup", 1, "ack");
    await done(d, "followup");

    expect(d.store.lane("followup")?.final?.text).toBe("fresh after interruption");
    expect(d.store.lane("followup")?.status).toBe("done");
  },
);

test.each([false, true])("legacy held entry acknowledgement preserves fresh READY=%s", async (fresh) => {
  const { d, ref } = await acceptedHeld();
  d.store.updateInbox(ref, (messages) =>
    messages.map(({ at, from, text, attempt }) => ({
      at,
      from,
      text,
      attempt: { at: attempt?.at ?? at, state: "ambiguous", detail: attempt?.detail ?? "legacy admission" },
    })),
  );
  if (fresh) await ready(d, "followup", "legacy fresh result", ["legacy.json"]);

  await releaseHeld(d, "followup", 1, "ack");

  if (fresh) {
    await done(d, "followup");
    expect(d.store.lane("followup")?.final?.text).toBe("legacy fresh result");
  } else {
    await expect(done(d, "followup")).rejects.toThrow(/not ready/);
  }
  expect(d.store.queued(ref)).toEqual([]);
});

test("resend clears uncertainty without claiming admission until actual delivery", async () => {
  const { f, d, ref } = await readyLane();
  f.admission("disconnect");
  expect(await send(d, "followup", "not admitted", "lead")).toBe("HELD");
  f.admission("accept");

  await releaseHeld(d, "followup", 1, "resend");

  expect(d.store.lane("followup")?.final?.text).toBe("initial result");
  expect(await flushInbox(d, ref)).toBe("delivered");
  f.finish(ref.id, "actual resend completed without READY");
  await expect(done(d, "followup")).rejects.toThrow(/not ready/);
});

test("resend after interrupted ack invalidates intervening READY on its new admission", async () => {
  const { f, d, ref } = await acceptedHeld();
  const interrupted = spyOn(d.store, "updateInbox").mockImplementationOnce(() => {
    throw new Error("operator acknowledgement interrupted");
  });
  try {
    await expect(releaseHeld(d, "followup", 1, "ack")).rejects.toThrow(/interrupted/);
  } finally {
    interrupted.mockRestore();
  }
  await ready(d, "followup", "intervening result", ["intervening.json"]);
  await releaseHeld(d, "followup", 1, "resend");

  expect(await flushInbox(d, ref)).toBe("delivered");
  f.finish(ref.id, "second admission without another READY");

  await expect(done(d, "followup")).rejects.toThrow(/not ready/);
  expect(d.store.lane("followup")?.final).toBeUndefined();
});
