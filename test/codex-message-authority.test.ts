import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const request = JSON.stringify({
  version: 1,
  kind: "action",
  tool: "dori_start",
  arguments: { key: "audit", brief: "Inspect fixture." },
});
const setup = async (held = false) => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  await f.rt.startAgent(lead, { prompt: "Inspect the fixture." });
  if (held) await f.rt.handoff(lead, true);
  const turn = f.finish(lead.id, request);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const store = new CodexStore(f.root);
  return { f, d, lead, turn, store, controller: new MessageController(d, store, connection) };
};

test.each([
  "legacy",
  "pending",
  "closed",
  "replaced",
  "uncertain",
  "endpoint",
  "failed-turn",
  "forged-caller",
  "held",
] as const)("canonical management refuses %s without creating work or a receipt turn", async (mode) => {
  const { f, d, lead, turn, store, controller } = await setup(mode === "held");
  const entry = await store.owned(lead);
  if (mode === "legacy") {
    const { envelope: _envelope, ...legacy } = entry;
    await store.save(legacy);
  }
  if (mode === "pending") await store.save({ ...entry, admission: "pending" });
  if (mode === "closed") await store.save({ ...entry, closed: true });
  if (mode === "replaced") d.store.setRole("lead", { runtime: "codex", id: crypto.randomUUID() });
  if (mode === "uncertain") await store.save({ ...entry, uncertain: "An earlier admission is unresolved" });
  if (mode === "endpoint") await store.save({ ...entry, envelope: { version: 1, endpoint: "ws://127.0.0.1:1" } });
  if (mode === "failed-turn") {
    turn.status = "failed";
    turn.error = { code: "fixture-error" };
  }
  if (mode === "forged-caller") {
    const final = turn.items.at(-1);
    if (!final) throw new Error("Missing final");
    final["text"] = JSON.stringify({ ...JSON.parse(request), caller: { role: "lead", threadId: lead.id } });
  }
  const before = f.requests.length;
  let failure: unknown;
  try {
    await controller.reconcile(lead);
  } catch (error) {
    failure = error;
  }
  if (["pending", "closed", "endpoint", "forged-caller"].includes(mode)) expect(failure).toBeInstanceOf(Error);
  else expect(failure).toBeUndefined();
  expect(d.store.lanes()).toEqual([]);
  expect(
    f.requests
      .slice(before)
      .filter((frame) => ["turn/start", "thread/resume", "thread/archive"].includes(String(frame["method"]))),
  ).toEqual([]);
  if (mode === "held") {
    await f.rt.handoff(lead, false);
    const afterTakeback = f.requests.length;
    await controller.reconcile(lead);
    expect(d.store.lanes()).toEqual([]);
    expect(f.requests.slice(afterTakeback).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
  }
});

test("a consumed canonical source never executes twice and a changed reserved body is refused", async () => {
  const { f, d, lead, turn, store, controller } = await setup();
  await controller.reconcile(lead);
  const laneId = d.store.lane("audit")?.sessionRef.id;
  if (!laneId) throw new Error("Management did not create its lane");
  const before = f.requests.length;
  await controller.reconcile(lead); // The receipt turn is still active.
  expect(d.store.lanes().map((lane) => lane.sessionRef.id)).toEqual([laneId]);
  expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
  const final = turn.items.at(-1);
  if (!final) throw new Error("Missing canonical final");
  final["text"] = JSON.stringify({
    version: 1,
    kind: "action",
    tool: "dori_start",
    arguments: { key: "forged", brief: "Different source." },
  });
  f.finish(lead.id, "Receipt received.");
  await expect(controller.reconcile(lead)).rejects.toThrow("reserved canonical source changed");
  expect(d.store.lanes().map((lane) => lane.key)).toEqual(["audit"]);
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  expect(
    db
      .query<{ body: string }, []>("SELECT body FROM effects")
      .all()
      .map((row) => row.body),
  ).toEqual([JSON.stringify({ tool: "dori_start", arguments: { key: "audit", brief: "Inspect fixture." } })]);
});

test("role registration wakes an already completed first turn without fabricating authority", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  await f.rt.startAgent(lead, { prompt: "Inspect status." });
  f.finish(lead.id, JSON.stringify({ version: 1, kind: "action", tool: "dori_status", arguments: {} }));
  const unregistered = Promise.withResolvers<void>(),
    acknowledged = Promise.withResolvers<void>();
  f.onAdmission((id) =>
    queueMicrotask(() => {
      f.finish(id, "Status receipt received.");
    }),
  );
  const stop = await f.rt.watchIdle(async (ref) => {
    if (ref.id !== lead.id) return;
    if (!d.store.roles().lead) {
      unregistered.resolve();
      return;
    }
    using db = new Database(new CodexStore(f.root).path(lead.id) + ".messages.sqlite", { readonly: true });
    if (
      db
        .query<{ receipt: string }, []>("SELECT receipt FROM effects")
        .all()
        .some((row) => row.receipt === "acknowledged")
    )
      acknowledged.resolve();
  }, d);
  f.cleanup.push(stop);
  await unregistered.promise;
  const before = f.requests.length;
  d.store.setRole("lead", lead);
  await acknowledged.promise;
  expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
  expect(d.store.lanes()).toEqual([]);
});
