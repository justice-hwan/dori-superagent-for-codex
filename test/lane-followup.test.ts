import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { flushInbox, send } from "../src/inbox.ts";
import { done, ready } from "../src/lanes.ts";
import { readyLane } from "./fixtures/ready-lane.ts";

test("delivered followup requires fresh READY before closure", async () => {
  const { f, d, ref } = await readyLane();
  expect(await send(d, "followup", "additional instructions", "lead")).toBe("DELIVERED");
  f.finish(ref.id, "followup finished without READY");

  await expect(done(d, "followup")).rejects.toThrow(/not ready/);

  expect(d.store.lane("followup")?.final).toBeUndefined();
  expect((await f.rt.probe(ref)).status).toBe("idle");
});

test("busy queued followup prevents idle READY closure", async () => {
  const { f, d, ref } = await readyLane();
  await f.rt.deliver(ref, "still finishing initial turn");
  expect(await send(d, "followup", "pending instructions", "lead")).toBe("QUEUED");
  expect(d.store.lane("followup")?.final?.text).toBe("initial result");
  f.finish(ref.id, "initial turn finished");

  await expect(done(d, "followup")).rejects.toThrow(/inbox|pending/);

  expect(d.store.queued(ref).map((message) => message.text)).toEqual(["pending instructions"]);
  expect((await f.rt.probe(ref)).status).toBe("idle");
});

test.each(["admission", "settlement", "acknowledgement"] as const)(
  "fresh READY survives confirmed admission recovery after failed %s",
  async (gap) => {
    const { f, d, ref } = await readyLane();
    let restore: (() => void) | undefined;
    f.onAdmission((id) => {
      if (id !== ref.id || restore) return;
      const fail =
        gap === "admission"
          ? spyOn(d.store, "saveLane").mockImplementationOnce(() => {
              throw new Error("admission interrupted");
            })
          : gap === "settlement"
            ? spyOn(d.store, "updateInbox").mockImplementationOnce(() => {
                throw new Error("settlement interrupted");
              })
            : spyOn(f.rt, "acknowledgeDelivery").mockImplementationOnce(async () => {
                throw new Error("acknowledgement interrupted");
              });
      restore = () => fail.mockRestore();
    });
    try {
      await expect(send(d, "followup", "new task", "lead")).rejects.toThrow(/interrupted/);
    } finally {
      restore?.();
    }
    expect(await f.rt.confirmedDelivery(ref)).toBeDefined();
    f.finish(ref.id, "new result");
    await ready(d, "followup", "fresh result", ["fresh.json"]);

    await flushInbox(d, ref);
    await done(d, "followup");

    expect(d.store.lane("followup")?.final?.text).toBe("fresh result");
    expect(d.store.lane("followup")?.status).toBe("done");
    expect(d.store.queued(ref)).toEqual([]);
    expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(2);
  },
);

test.each(["before", "after"])("fresh READY survives actual sender exit %s queue settlement", async (gap) => {
  const { f, d, ref } = await readyLane();
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./fixtures/codex-crash-gap.ts", import.meta.url)),
      `codex:${ref.id}`,
      gap,
    ],
    {
      env: { ...process.env, ...f.env, DORI_HOME: f.root, DORI_RUNTIME: "codex", DORI_CODEX_BRIDGE: "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ code, stderr }).toEqual({ code: 77, stderr: "" });
  f.finish(ref.id, "completed after sender exited");
  await ready(d, "followup", "post-crash result", ["post-crash.json"]);

  await flushInbox(d, ref);
  await done(d, "followup");

  expect(d.store.lane("followup")?.final?.text).toBe("post-crash result");
  expect(d.store.lane("followup")?.status).toBe("done");
  expect(d.store.queued(ref)).toEqual([]);
});

test("send racing an actual close cannot strand accepted followup work", async () => {
  const { f, d, ref } = await readyLane();
  const closing = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const close = f.rt.close.bind(f.rt);
  const barrier = spyOn(f.rt, "close").mockImplementation(async (target) => {
    closing.resolve();
    await proceed.promise;
    return close(target);
  });
  const finished = done(d, "followup");
  await closing.promise;
  const followup = send(d, "followup", "racing instructions", "lead").then(
    (delivery) => ({ delivery }),
    (error: unknown) => ({ error }),
  );
  try {
    await expect(followup).resolves.toHaveProperty("error");
  } finally {
    proceed.resolve();
    await finished;
    barrier.mockRestore();
  }

  expect(d.store.queued(ref)).toEqual([]);
  expect(d.store.lane("followup")?.status).toBe("done");
});
