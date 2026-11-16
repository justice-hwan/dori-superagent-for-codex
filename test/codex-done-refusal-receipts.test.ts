import { expect, onTestFinished, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Refusal } from "../src/refusal.ts";
import * as preparation from "../src/runtime/codex/done-admission.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { array, CodexConnection, CodexError, object, text } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { managementFinal } from "../src/runtime/codex/message-schema.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const action = (tool: string, args: object) => JSON.stringify({ version: 1, kind: "action", tool, arguments: args });
const failure = (error: unknown) => {
  if (error instanceof Refusal || error instanceof CodexError)
    return { name: error.name, message: error.message, kind: error instanceof CodexError ? error.kind : undefined };
  throw error;
};

test.each(["missing", "working"] as const)(
  "done for a %s lane returns a source-bound failed receipt and permits subsequent status",
  async (state) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    d.store.setRole("lead", lead);
    if (state === "working") {
      const target = await f.rt.create({ ...f.spec, role: "lane", env: { DORI_LANE: "audit" } });
      d.store.saveLane({
        key: "audit",
        sessionRef: target,
        paneId: target.id,
        tabId: "",
        brief: "fixture",
        cwd: f.spec.cwd,
        status: "working",
        createdAt: d.now(),
        lastActivityAt: d.now(),
        nudges: 0,
        log: [],
      });
    }
    const store = new CodexStore(f.root);
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const controller = new MessageController(d, store, connection);
    const nativeReceipts = () =>
      f.requests
        .filter((frame) => frame["method"] === "turn/start" && object(frame["params"])["threadId"] === lead.id)
        .flatMap((frame) => {
          const body = array(object(frame["params"])["input"]).map(object)[0]?.["text"];
          if (typeof body !== "string" || !body.startsWith("{")) return [];
          const parsed = object(JSON.parse(body));
          return parsed["kind"] === "dori_receipt" ? [parsed] : [];
        });

    await f.rt.startAgent(lead, { prompt: "Close audit if it is ready." });
    const done = f.finish(lead.id, action("dori_done", { key: "audit" }));
    const doneSource = { threadId: lead.id, turnId: done.id, itemId: text(done.items.at(-1)?.["id"]) };
    const doneFailure = await controller
      .reconcile(lead, { method: "turn/completed", params: { threadId: lead.id, turn: done } })
      .then(() => undefined, failure);
    const declined = nativeReceipts().find((receipt) => object(receipt["source"])["turnId"] === done.id);

    // Complete only a receipt actually delivered by the product; never manufacture one in the fake.
    if (declined) {
      const ack = f.finish(lead.id, "Receipt acknowledged.");
      await controller.reconcile(lead, { method: "turn/completed", params: { threadId: lead.id, turn: ack } });
    }
    await f.rt.startAgent(lead, { prompt: "Inspect status after the declined close." });
    const status = f.finish(lead.id, action("dori_status", {}));
    const statusSource = { threadId: lead.id, turnId: status.id, itemId: text(status.items.at(-1)?.["id"]) };
    const statusFailure = await controller
      .reconcile(lead, { method: "turn/completed", params: { threadId: lead.id, turn: status } })
      .then(() => undefined, failure);
    const statusReceipt = nativeReceipts().find((receipt) => object(receipt["source"])["turnId"] === status.id);
    using journal = new MessageJournal(store, lead.id);
    const doneEffect = journal.effect(done.id);
    const observation = {
      state,
      doneFailure: doneFailure ?? null,
      doneConsumed: journal.seen(done.id),
      doneEffect: doneEffect ? { state: doneEffect.state, receipt: doneEffect.receipt } : null,
      declined: declined ?? null,
      statusFailure: statusFailure ?? null,
      statusConsumed: journal.seen(status.id),
      statusReceipt: statusReceipt ?? null,
      nativeClosures: f.calls.filter((method) => method === "thread/unsubscribe" || method === "thread/archive"),
    };
    console.log("DONE_PREPARATION_REFUSAL_REPRO", JSON.stringify({ ...observation, doneSource, statusSource }));
    expect(observation).toMatchObject({
      doneFailure: null,
      doneConsumed: true,
      doneEffect: { state: "completed", receipt: "acknowledged" },
      declined: {
        kind: "dori_receipt",
        ok: false,
        source: doneSource,
        result: { error: expect.any(String) },
      },
      statusFailure: null,
      statusConsumed: true,
      statusReceipt: { kind: "dori_receipt", ok: true, source: statusSource },
      nativeClosures: [],
    });
  },
);

test.each(["same", "item", "action", "foreign", "dispatching", "uncertain"] as const)(
  "refusal-only journal preserves identity and existing effects for %s",
  async (mode) => {
    const { f } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    await f.rt.startAgent(lead, { prompt: "Inspect status." });
    const turn = f.finish(lead.id, action("dori_status", {}));
    const final = managementFinal(lead.id, object(turn));
    if (!final) throw new Error("Missing canonical status source");
    using journal = new MessageJournal(new CodexStore(f.root), lead.id);
    if (mode === "dispatching" || mode === "uncertain") {
      journal.reserve(final);
      if (mode === "uncertain") journal.uncertain(final, new CodexError("uncertain", "Held existing effect"));
    } else journal.decline(final, new Refusal("First declined result"));
    const before = journal.effect(turn.id);
    if (!before) throw new Error("Missing actual journal effect");
    const candidate =
      mode === "item"
        ? { ...final, source: { ...final.source, itemId: crypto.randomUUID() } }
        : mode === "action"
          ? { ...final, action: { tool: "dori_done", arguments: { key: "audit" } } }
          : mode === "foreign"
            ? { ...final, source: { ...final.source, threadId: crypto.randomUUID() } }
            : final;
    const decline = () => journal.decline(candidate, new Refusal("Replacement must not overwrite"));
    if (mode === "same") {
      expect(decline).not.toThrow();
      expect(JSON.parse(before.result)).toMatchObject({
        source: final.source,
        ok: false,
        result: { error: "First declined result" },
      });
    } else {
      expect(decline).toThrow(
        mode === "foreign"
          ? "Management source thread changed"
          : mode === "dispatching" || mode === "uncertain"
            ? "unresolved"
            : "Canonical management source changed",
      );
    }
    expect(journal.effect(turn.id)).toEqual(before);
  },
);

test("refusal-only receipt serialization failure rolls back source consumption", async () => {
  const { f } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  await f.rt.startAgent(lead, { prompt: "Inspect status." });
  const final = managementFinal(lead.id, object(f.finish(lead.id, action("dori_status", {}))));
  if (!final) throw new Error("Missing canonical status source");
  using journal = new MessageJournal(new CodexStore(f.root), lead.id);
  expect(() => journal.decline(final, new Refusal("x".repeat(65536)))).toThrow("exceeds 64 KiB");
  expect(journal.seen(final.source.turnId)).toBe(false);
  journal.decline(final, new Refusal("Bounded result"));
  expect(journal.effect(final.source.turnId)?.state).toBe("completed");
});

test.each(["stop", "registration", "workspace", "desktop", "uncertain", "confirmed"] as const)(
  "refused preparation does not consume its source after %s changes",
  async (mode) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    d.store.setRole("lead", lead);
    await f.rt.startAgent(lead, { prompt: "Close a missing audit." });
    const turn = f.finish(lead.id, action("dori_done", { key: "audit" }));
    const store = new CodexStore(f.root);
    const entry = await store.owned(lead);
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const original = preparation.prepareBoundDone;
    const held = spyOn(preparation, "prepareBoundDone").mockImplementation((...args) =>
      original(...args).catch(async (error: unknown) => {
        if (!(error instanceof Refusal)) throw error;
        entered.resolve();
        await proceed.promise;
        throw error;
      }),
    );
    onTestFinished(() => {
      proceed.resolve();
      held.mockRestore();
    });
    const before = f.requests.length;
    const run = new MessageController(d, store, connection).reconcile(lead, {
      method: "turn/completed",
      params: { threadId: lead.id, turn },
    });
    await entered.promise;
    if (mode === "stop") d.store.setStop(d.now(), "Pause during refused preparation", "duty");
    if (mode === "registration") d.store.setRole("lead", { runtime: "codex", id: crypto.randomUUID() });
    if (mode === "workspace") await store.save({ ...entry, spec: { ...entry.spec, cwd: f.root } });
    if (mode === "desktop") await store.save({ ...entry, desktopOwned: true });
    if (mode === "uncertain") await store.save({ ...entry, uncertain: "Held source" });
    if (mode === "confirmed") await store.save({ ...entry, confirmed: { id: "batch", messageIds: ["message"] } });
    proceed.resolve();
    await run;
    using journal = new MessageJournal(store, lead.id);
    using db = new Database(`${store.path(lead.id)}.messages.sqlite`, { readonly: true });
    expect(journal.seen(turn.id)).toBe(false);
    expect(db.query("SELECT * FROM effects").all()).toEqual([]);
    expect(
      f.requests
        .slice(before)
        .filter((frame) => ["turn/start", "thread/unsubscribe", "thread/archive"].includes(String(frame["method"]))),
    ).toEqual([]);
  },
);
