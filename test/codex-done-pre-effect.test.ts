import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection, object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

for (const resource of ["inbox", "submit"] as const) {
  test(`done target ${resource} contention is deferred before any effect`, async () => {
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
    const release =
      resource === "inbox"
        ? d.store.lockInbox(lane, d.now())
        : takeInboxLock(`${store.path(lane.id)}.submit-lock`, Date.now());
    if (!release) throw new Error("Missing actual target reservation");
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const controller = new MessageController(d, store, connection);
    try {
      const before = f.requests.length;
      await controller
        .reconcile(lead, {
          method: "turn/completed",
          params: { threadId: lead.id, turn },
        })
        .catch(() => undefined);
      using journal = new Database(`${store.path(lead.id)}.messages.sqlite`, {
        readonly: true,
      });
      expect(journal.query("SELECT * FROM effects").all()).toEqual([]);
      expect(f.requests.slice(before).filter((request) => object(request["params"])["threadId"] === lane.id)).toEqual(
        [],
      );
      expect(d.store.lane("audit")?.status).toBe("ready");
    } finally {
      release();
    }
    // A new controller can recover the bound intent, without a new completion or native source turn.
    await new MessageController(d, store, connection).reconcile(lead);
    expect(d.store.lane("audit")?.status).toBe("done");
    using journal = new Database(`${store.path(lead.id)}.messages.sqlite`, {
      readonly: true,
    });
    expect(journal.query("SELECT * FROM effects").all()).toHaveLength(1);
    expect(f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
  });
}
