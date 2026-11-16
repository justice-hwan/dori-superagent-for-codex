import { expect, onTestFinished, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
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

for (const cut of ["target-save", "source-complete"] as const) {
  test("close crash cut remains nonreplayable: " + cut, async () => {
    const s = await setup();
    const failure = new Error("Fixture close crash at " + cut);
    const save = s.store.save.bind(s.store);
    s.store.save = async (entry) => {
      if (cut === "target-save" && entry.id === s.lane.id && entry.closed) throw failure;
      return save(entry);
    };
    const complete = MessageJournal.prototype.complete;
    const completion = spyOn(MessageJournal.prototype, "complete").mockImplementation(function (
      this: MessageJournal,
      ...args
    ) {
      if (cut === "source-complete" && args[0].action.tool === "dori_done") throw failure;
      return complete.call(this, ...args);
    });
    onTestFinished(() => {
      s.store.save = save;
      completion.mockRestore();
    });
    await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead, s.event)).rejects.toThrow(failure);
    expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
    expect((await s.store.owned(s.lane, true)).closed).toBe(cut === "source-complete");
    expect(s.d.store.lane("audit")?.status).toBe(cut === "source-complete" ? "done" : "ready");
    s.store.save = save;
    completion.mockRestore();
    await expect(new MessageController(s.d, s.store, s.connection).reconcile(s.lead)).rejects.toThrow("never replay");
    expect(s.f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
    using db = new Database(s.store.path(s.lead.id) + ".messages.sqlite", { readonly: true });
    expect(db.query("SELECT state FROM effects").all()).toEqual([{ state: "uncertain" }]);
  });
}
