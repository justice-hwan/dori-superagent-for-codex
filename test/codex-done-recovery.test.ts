import { expect, onTestFinished, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection, object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

async function setup() {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  const lane = await f.rt.create({
    ...f.spec,
    role: "lane",
    env: { DORI_LANE: "audit" },
  });
  d.store.setRole("lead", lead);
  d.store.saveLane({
    key: "audit",
    sessionRef: lane,
    paneId: lane.id,
    tabId: "",
    brief: "fixture",
    cwd: f.spec.cwd,
    status: "ready",
    createdAt: d.now(),
    lastActivityAt: d.now(),
    nudges: 0,
    log: [],
    final: { text: "Evidence", evidence: ["fixture"], at: d.now() },
  });
  await f.rt.startAgent(lead, { prompt: "Close the ready audit" });
  const turn = f.finish(
    lead.id,
    JSON.stringify({
      version: 1,
      kind: "action",
      tool: "dori_done",
      arguments: { key: "audit" },
    }),
  );
  const store = new CodexStore(f.root);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  return {
    f,
    d,
    lead,
    lane,
    turn,
    store,
    connection,
    event: { method: "turn/completed", params: { threadId: lead.id, turn } },
  };
}

test("actual startup watcher holds an unbound historical key-only done", async () => {
  const s = await setup();
  const refused = Promise.withResolvers<void>();
  const write = process.stderr.write.bind(process.stderr);
  const diagnostic = spyOn(process.stderr, "write").mockImplementation((value) => {
    if (String(value).includes("Unbound historical done")) refused.resolve();
    return write(value);
  });
  onTestFinished(() => diagnostic.mockRestore());
  const stop = await s.f.rt.watchIdle(async () => {}, s.d);
  s.f.cleanup.push(stop);
  await refused.promise;
  stop();
  expect(s.d.store.lane("audit")?.status).toBe("ready");
  using db = new Database(`${s.store.path(s.lead.id)}.messages.sqlite`, {
    readonly: true,
  });
  expect(db.query("SELECT * FROM close_targets").all()).toEqual([]);
  expect(db.query("SELECT * FROM effects").all()).toEqual([]);
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toEqual([]);
});

test("unbound recovery without a new canonical completion fails closed", async () => {
  const s = await setup();
  await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead)).rejects.toThrow(
    "Unbound historical done",
  );
  expect(s.d.store.lane("audit")?.status).toBe("ready");
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toEqual([]);
});

for (const change of ["replacement", "new-admission"] as const) {
  test(`restart cannot close a changed bound target: ${change}`, async () => {
    const s = await setup();
    const release = s.d.store.lockInbox(s.lane, s.d.now());
    if (!release) throw new Error("Missing target fixture reservation");
    try {
      expect(await new MessageController(s.d, s.store, s.connection).reconcile(s.lead, s.event)).toMatchObject({
        kind: "target-busy",
        id: s.lane.id,
      });
    } finally {
      release();
    }
    const original = s.d.store.lane("audit");
    if (!original) throw new Error("Missing bound fixture lane");
    const successor =
      change === "replacement"
        ? await s.f.rt.create({
            ...s.f.spec,
            role: "lane",
            env: { DORI_LANE: "audit" },
          })
        : s.lane;
    s.d.store.saveLane({
      ...original,
      sessionRef: successor,
      paneId: successor.id,
      admissionId: "new-task",
      admissionOrder: 2,
      final: { text: "Newer READY", evidence: ["newer"], at: s.d.now() + 1 },
    });
    const before = s.f.requests.length;
    await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead)).rejects.toThrow();
    expect(s.f.requests.slice(before).filter((request) => request["method"] === "thread/unsubscribe")).toEqual([]);
    expect(s.d.store.lane("audit")?.sessionRef.id).toBe(successor.id);
    expect(s.d.store.lane("audit")?.status).toBe("ready");
    using db = new Database(`${s.store.path(s.lead.id)}.messages.sqlite`, {
      readonly: true,
    });
    expect(db.query("SELECT * FROM close_targets").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM effects").all()).toEqual([]);
  });
}

test("close performed before lane persistence failure remains uncertain and cannot replay", async () => {
  const s = await setup();
  const save = s.d.store.saveLane.bind(s.d.store);
  s.d.store.saveLane = (lane) => {
    if (lane.status === "done") throw new Error("Fixture crash cut after target close");
    return save(lane);
  };
  await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead, s.event)).rejects.toThrow(
    "Fixture crash cut after target close",
  );
  expect((await s.store.owned(s.lane, true)).closed).toBe(true);
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
  s.d.store.saveLane = save;
  await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead)).rejects.toThrow("never replay");
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
  using db = new Database(`${s.store.path(s.lead.id)}.messages.sqlite`, {
    readonly: true,
  });
  expect(db.query("SELECT state FROM effects").all()).toEqual([{ state: "uncertain" }]);
});

test("marker publication failure after real close does not make the completed effect retryable", async () => {
  const s = await setup();
  const marker = `${s.store.path(s.lane.id)}.submit-released`;
  const rename = fs.renameSync;
  const failed = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (to === marker) throw new Error("Fixture target release hint failure");
    return rename(from, to);
  });
  onTestFinished(() => failed.mockRestore());
  await new MessageController(s.d, s.store, s.connection).reconcile(s.lead, s.event);
  expect(s.d.store.lane("audit")?.status).toBe("done");
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
  using db = new Database(`${s.store.path(s.lead.id)}.messages.sqlite`, { readonly: true });
  expect(db.query("SELECT state FROM effects").all()).toEqual([{ state: "completed" }]);
  expect(db.query("SELECT * FROM close_targets").all()).toHaveLength(1);
  await new MessageController(s.d, s.store, s.connection).reconcile(s.lead);
  expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
});

for (const side of ["source", "target"] as const) {
  for (const field of ["uncertain", "admission", "desktopOwned"] as const) {
    test(`malformed ${side} ${field} cannot enter a prepared effect`, async () => {
      const s = await setup();
      const ref = side === "source" ? s.lead : s.lane;
      const path = s.store.path(ref.id);
      const record = object(await Bun.file(path).json());
      await Bun.write(path, JSON.stringify({ ...record, [field]: 7 }));
      const before = s.f.requests.length;
      await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead, s.event)).rejects.toThrow();
      expect(
        s.f.requests.slice(before).filter((request) => object(request["params"])["threadId"] === s.lane.id),
      ).toEqual([]);
      using db = new Database(`${s.store.path(s.lead.id)}.messages.sqlite`, {
        readonly: true,
      });
      expect(db.query("SELECT * FROM effects").all()).toEqual([]);
      expect(s.d.store.lane("audit")?.status).toBe("ready");
    });
  }
}
