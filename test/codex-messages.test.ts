import { Database } from "bun:sqlite";
import { expect, onTestFinished, spyOn, test } from "bun:test";
import * as bridge from "../src/runtime/codex/bridge-tools.ts";
import { join } from "node:path";
import { object, array, text, CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { harnessFixture } from "./codex-fixture.test.ts";
import { flushInbox } from "../src/inbox.ts";

const action = (tool: string, args: object) => JSON.stringify({ version: 1, kind: "action", tool, arguments: args });

test("duty controller runs a real lead-lane report READY and done workflow without a management child", async () => {
  const { f, d } = await harnessFixture();
  const inboxFreeAtEffect: boolean[] = [];
  const dispatch = bridge.callBridgeTool;
  const effect = spyOn(bridge, "callBridgeTool").mockImplementation(async (...args) => {
    const source = { runtime: "codex", id: args[1].id } as const;
    const release = d.store.lockInbox(source, d.now());
    inboxFreeAtEffect.push(release !== undefined);
    release?.();
    return dispatch(...args);
  });
  onTestFinished(() => effect.mockRestore());
  const evidence = join(f.spec.cwd, "result.txt");
  await Bun.write(evidence, "Inspected 3 fixture rows.\n");
  const lead = await f.rt.create({
    ...f.spec,
    role: "lead",
    name: "lead",
    env: {},
  });
  d.store.setRole("lead", lead);
  const finished = Promise.withResolvers<void>();
  let completed = false;
  const callbacks: unknown[] = [];
  onTestFinished(() => {
    if (completed) return;
    console.error(
      "MESSAGE_WORKFLOW_TIMEOUT",
      JSON.stringify({
        callbacks,
        requests: f.requests,
        threads: [...f.threads],
        inboxFreeAtEffect,
      }),
    );
  });
  const foreign = "CAPTURE_FOREIGN_SUBSCRIPTION_SENTINEL";
  f.onAdmission((id) => {
    f.barrier(foreign);
    const request = f.requests.at(-1);
    const input = array(object(request?.["params"])["input"]).map(object);
    const prompt = text(input[0]?.["text"]);
    queueMicrotask(() => {
      if (id === lead.id) {
        f.finish(
          id,
          prompt === "Delegate an audit and inspect its evidence."
            ? action("dori_start", {
                key: "audit",
                brief: "Inspect the fixture and return evidence.",
              })
            : prompt.includes("[READY audit]")
              ? action("dori_done", { key: "audit" })
              : "Progress received.",
        );
      } else {
        f.finish(
          id,
          prompt.includes('"kind":"dori_receipt"')
            ? action("dori_ready", {
                text: "Inspected 3 rows.",
                evidence: [evidence],
              })
            : action("dori_report", {
                text: "Evidence prepared.",
                status: "working",
              }),
        );
      }
    });
  });
  const stop = await f.rt.watchIdle(async (ref) => {
    await flushInbox(d, ref);
    callbacks.push({ ref, lane: d.store.lane("audit") });
    if (ref.id !== lead.id || d.store.lane("audit")?.status !== "done") return;
    using journal = new Database(join(f.root, "codex/sessions", `${lead.id}.json.messages.sqlite`), { readonly: true });
    const rows = journal.query<{ body: string; receipt: string }, []>("SELECT body,receipt FROM effects").all();
    callbacks.push({ rows });
    if (rows.some((row) => JSON.parse(row.body).tool === "dori_done" && row.receipt === "acknowledged"))
      finished.resolve();
  }, d);
  f.cleanup.push(stop);
  await f.rt.startAgent(lead, {
    prompt: "Delegate an audit and inspect its evidence.",
  });
  await finished.promise;
  completed = true;
  // Done executes through the admitted lifecycle closure; the other three use the ordinary bridge.
  expect(inboxFreeAtEffect).toHaveLength(3);
  expect(inboxFreeAtEffect.every(Boolean)).toBe(true);
  const lane = d.store.lane("audit");
  if (!lane) throw new Error("Missing real created lane");
  expect(lane).toMatchObject({
    status: "done",
    final: { text: "Inspected 3 rows.", evidence: [evidence] },
  });
  expect(f.threads.size).toBe(2);
  using leadJournal = new Database(join(f.root, "codex/sessions", `${lead.id}.json.messages.sqlite`), {
    readonly: true,
  });
  const leadEffects = leadJournal.query<{ body: string; state: string }, []>("SELECT body,state FROM effects").all();
  expect(leadEffects.map((row) => [JSON.parse(row.body).tool, row.state])).toEqual([
    ["dori_start", "completed"],
    ["dori_done", "completed"],
  ]);
  expect(d.store.queued(lead)).toEqual([]);
  const starts = f.requests.filter((request) => request["method"] === "thread/start");
  expect(starts).toHaveLength(2);
  for (const request of starts) expect(object(object(request["params"])["config"])["mcp_servers"]).toEqual({});
  using child = new Database(join(f.root, "codex/sessions", `${lane.sessionRef.id}.json.messages.sqlite`), {
    readonly: true,
  });
  const effects = child
    .query<{ body: string; receipt: string }, []>("SELECT body,receipt FROM effects ORDER BY rowid")
    .all();
  expect(effects.map((row) => [JSON.parse(row.body).tool, row.receipt])).toEqual([
    ["dori_report", "continued"],
    ["dori_ready", "locally-settled"],
  ]);
  expect(
    f.requests.filter(
      (request) => request["method"] === "turn/start" && object(request["params"])["threadId"] === lane.sessionRef.id,
    ),
  ).toHaveLength(2);
  expect(lane.log.filter((entry) => entry.kind === "ready")).toHaveLength(1);
  for (const id of [lead.id, lane.sessionRef.id]) {
    using audit = new Database(join(f.root, "codex/sessions", `${id}.json.messages.sqlite`), { readonly: true });
    expect(JSON.stringify(audit.query("SELECT body FROM progress").all())).not.toContain(foreign);
  }
});
test.each(["", " \t\n"])(
  "READY before receipt drain keeps terminal settlement and acknowledges blank %j once",
  async (answer) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    d.store.setRole("lead", lead);
    await f.rt.startAgent(lead, { prompt: "Delegate fixture work." });
    f.finish(lead.id, action("dori_start", { key: "audit", brief: "Return inspected evidence." }));
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const store = new CodexStore(f.root),
      controller = new MessageController(d, store, connection);
    await controller.reconcile(lead);
    const lane = d.store.lane("audit");
    if (!lane) throw new Error("Missing product-created lane");
    const ref = lane.sessionRef;
    const report = f.finish(ref.id, action("dori_report", { text: "Evidence inspected.", status: "working" }));
    await connection.call("turn/start", {
      threadId: ref.id,
      clientUserMessageId: crypto.randomUUID(),
      input: [{ type: "text", text: "Finish existing task.", text_elements: [] }],
    });
    const ready = f.finish(ref.id, action("dori_ready", { text: "Inspection complete.", evidence: [f.spec.cwd] }));
    const before = f.requests.length;
    await controller.reconcile(ref);
    using db = new Database(store.path(ref.id) + ".messages.sqlite", { readonly: true });
    expect(db.query("SELECT turn,receipt FROM effects ORDER BY rowid").all()).toEqual([
      { turn: report.id, receipt: "delivered" },
      { turn: ready.id, receipt: "locally-settled" },
    ]);
    const accepted = f.threads.get(ref.id)?.turns.at(-1);
    if (!accepted) throw new Error("Missing actual accepted report receipt");
    const client = accepted.items[0]?.["clientId"];
    f.finish(ref.id, answer);
    await controller.reconcile(ref);
    await controller.reconcile(ref);
    expect(db.query("SELECT turn,receipt,client,accepted FROM effects ORDER BY rowid").all()).toEqual([
      { turn: report.id, receipt: "acknowledged", client, accepted: accepted.id },
      { turn: ready.id, receipt: "locally-settled", client: "", accepted: "" },
    ]);
    const current = d.store.lane("audit");
    expect(current?.status).toBe("ready");
    expect(current?.log.filter((row) => row.kind === "report")).toHaveLength(1);
    expect(current?.log.filter((row) => row.kind === "ready")).toHaveLength(1);
    expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toHaveLength(1);
    expect(db.query("SELECT kind FROM progress WHERE kind='receipt/uncertain'").all()).toEqual([]);
    const progress = db.query<{ kind: string; body: string }, []>("SELECT kind,body FROM progress ORDER BY seq").all();
    const observed = progress.filter((row) => row.kind === "turn/observed").map((row) => JSON.parse(row.body).turnId);
    expect(observed).toEqual([report.id, ready.id, accepted.id]);
    const readyIndex = progress.findIndex(
      (row) => row.kind === "turn/observed" && JSON.parse(row.body).turnId === ready.id,
    );
    const receiptIndex = progress.findIndex(
      (row) => row.kind === "submission/accepted" && JSON.parse(row.body).turn === accepted.id,
    );
    expect(readyIndex).toBeLessThan(receiptIndex);
  },
);
