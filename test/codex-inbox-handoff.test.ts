import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { flushInbox, send } from "../src/inbox.ts";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection, object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

for (const duty of [false, true]) {
  test(`accepted inbox acknowledgement survives concurrent duty: ${duty}`, async () => {
    const { f, d } = await harnessFixture();
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const response = object(await connection.call("thread/start", { cwd: f.spec.cwd }));
    const id = object(response["thread"])["id"];
    if (typeof id !== "string") throw new Error("Missing fixture thread");
    const ref = { runtime: "codex", id } as const;
    const store = new CodexStore(f.root);
    await store.save({
      id,
      closed: false,
      spec: { ...f.spec, role: "lead", env: {} },
      envelope: { version: 1, endpoint: connection.address },
    });
    d.store.setRole("lead", ref);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let contender: Promise<unknown> | undefined;
    const actualCall = connection.call.bind(connection);
    connection.call = async (method, params) => {
      const value = await actualCall(method, params);
      if (method === "thread/read") {
        held.resolve();
        await release.promise;
      }
      return value;
    };
    const actualDeliver = f.rt.deliver.bind(f.rt);
    const newerId = crypto.randomUUID();
    f.rt.deliver = async (reference, prompt, options) => {
      expect(options?.batch).toBeDefined();
      expect(d.store.lockInbox(reference, d.now())).toBeUndefined();
      const outcome = await actualDeliver(reference, prompt, options);
      expect(outcome.kind).toBe("delivered");
      d.store.enqueue(ref, {
        at: d.now() + 1,
        from: "newer",
        text: "Preserve newer work",
        deliveryId: newerId,
      });
      if (duty) {
        contender = new MessageController(d, store, connection).reconcile(ref);
        await Promise.race([held.promise, contender]);
      }
      return outcome;
    };
    try {
      const outcome = await send(d, "lead", "Accept exactly once", "handoff").then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(1);
      using db = new Database(`${store.path(id)}.messages.sqlite`, { readonly: true });
      expect(db.query("SELECT client FROM submissions").all()).toHaveLength(1);
      expect(d.store.queued(ref).map((message) => message.deliveryId)).toEqual([newerId]);
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toBe("DELIVERED");
      expect((await store.owned(ref)).confirmed).toBeUndefined();
    } finally {
      release.resolve();
      await contender;
    }
  });
}

for (const cut of ["accepted", "settled", "acknowledged"] as const) {
  test(`inbox recovers ${cut} cut without another submission`, async () => {
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
    const actualDeliver = f.rt.deliver.bind(f.rt);
    const actualAck = f.rt.acknowledgeDelivery.bind(f.rt);
    const interruption = new Error(`Fixture interruption at ${cut}`);
    if (cut === "accepted") {
      f.rt.deliver = async (...args) => {
        const result = await actualDeliver(...args);
        expect(result.kind).toBe("delivered");
        throw interruption;
      };
    } else {
      f.rt.acknowledgeDelivery = async (...args) => {
        if (cut === "acknowledged") await actualAck(...args);
        throw interruption;
      };
    }
    await expect(send(d, "lead", "Exactly once across crash cut", "crash-fixture")).rejects.toThrow(interruption);
    f.rt.deliver = actualDeliver;
    f.rt.acknowledgeDelivery = actualAck;
    expect(d.store.queued(ref)).toHaveLength(cut === "accepted" ? 1 : 0);
    expect(Boolean((await store.owned(ref)).confirmed)).toBe(cut !== "acknowledged");
    const controller = new MessageController(d, store, connection);
    const before = f.calls.length;
    await controller.reconcile(ref);
    if (cut !== "acknowledged") expect(f.calls.length).toBe(before);
    await flushInbox(d, ref);
    expect((await store.owned(ref)).confirmed).toBeUndefined();
    expect(d.store.queued(ref)).toEqual([]);
    expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(1);
  });
}
