import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { harnessFixture } from "./codex-fixture.test.ts";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { deliver } from "../src/runtime/codex/delivery.ts";
import { takeManagedSubmit } from "../src/runtime/codex/submit-lock.ts";
import { send, flushInbox } from "../src/inbox.ts";

test("two nonterminal source turns drain exact receipts in FIFO before ordinary inbox work", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  await f.rt.startAgent(lead, { prompt: "First source." });
  const first = f.finish(lead.id, action);
  expect(await f.rt.deliver(lead, "Second source.")).toMatchObject({ kind: "delivered" });
  const second = f.finish(lead.id, action);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const store = new CodexStore(f.root),
    controller = new MessageController(d, store, connection);
  await controller.reconcile(lead);
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  const receipts = () => db.query("SELECT turn,receipt FROM effects ORDER BY rowid").all();
  expect(receipts()).toEqual([
    { turn: first.id, receipt: "delivered" },
    { turn: second.id, receipt: "queued" },
  ]);
  expect(await send(d, "lead", "After both receipts.", "fixture")).toBe("QUEUED");
  f.finish(lead.id, "First receipt acknowledged.");
  const restarted = new MessageController(d, new CodexStore(f.root), connection);
  await restarted.reconcile(lead);
  expect(receipts()).toEqual([
    { turn: first.id, receipt: "acknowledged" },
    { turn: second.id, receipt: "delivered" },
  ]);
  expect(await flushInbox(d, lead)).toBe("queued");
  f.finish(lead.id, "Second receipt acknowledged.");
  await restarted.reconcile(lead);
  expect(await flushInbox(d, lead)).toBe("delivered");
  expect(await f.rt.confirmedDelivery(lead)).toBeUndefined();
  expect(d.store.queued(lead)).toEqual([]);
  f.finish(lead.id, "Ordinary work received.");
  await restarted.reconcile(lead);
  expect(receipts()).toEqual([
    { turn: first.id, receipt: "acknowledged" },
    { turn: second.id, receipt: "acknowledged" },
  ]);
  const accepted = db.query<{ turn: string }, []>("SELECT turn FROM submissions").all();
  expect(accepted).toHaveLength(5);
  expect(new Set(accepted.map((row) => row.turn)).size).toBe(5);
  expect(f.requests.filter((request) => request["method"] === "turn/start")).toHaveLength(5);
});
const action = JSON.stringify({ version: 1, kind: "action", tool: "dori_status", arguments: {} });
async function setup() {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  await f.rt.startAgent(lead, { prompt: "Inspect work." });
  const source = f.finish(lead.id, action);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const store = new CodexStore(f.root),
    controller = new MessageController(d, store, connection);
  await controller.reconcile(lead);
  const thread = f.threads.get(lead.id);
  if (!thread) throw new Error("Missing real fixture thread");
  return { f, d, lead, source, connection, store, controller, thread };
}
for (const state of ["queued", "dispatching", "delivered", "uncertain"] as const)
  test("ordinary inbox remains queued behind durable receipt " + state, async () => {
    const { f, d, lead, store, thread } = await setup();
    // Model persisted states after interrupted receipt dispatch; all effects originate in the actual controller.
    using db = new Database(store.path(lead.id) + ".messages.sqlite");
    db.run("UPDATE effects SET receipt=?", [state]);
    thread.status = { type: "idle" };
    const before = f.requests.filter((request) => request["method"] === "turn/start").length;
    expect(await send(d, "lead", "Queued work A", "fixture")).toBe("QUEUED");
    expect(await flushInbox(d, lead)).toBe("queued");
    expect(d.store.queued(lead).map((message) => message.text)).toEqual(["Queued work A"]);
    expect(f.requests.filter((request) => request["method"] === "turn/start")).toHaveLength(before);
    const release = takeManagedSubmit(store, lead.id);
    expect(release).toBeDefined();
    release?.();
  });
test("stale idle and restart keep batches queued across receipt continuations then deliver once", async () => {
  const { f, d, lead, store, connection, thread } = await setup();
  thread.status = { type: "idle" };
  expect(await send(d, "lead", "Batch A", "fixture")).toBe("QUEUED");
  // A new controller has no in-memory admission state. Persisted receipt occupancy is authoritative.
  const restarted = new MessageController(d, new CodexStore(f.root), connection);
  f.finish(lead.id, action);
  await restarted.reconcile(lead);
  thread.status = { type: "idle" };
  expect(await send(d, "lead", "Batch B", "fixture")).toBe("QUEUED");
  expect(await flushInbox(d, lead)).toBe("queued");
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  expect(db.query("SELECT receipt FROM effects ORDER BY rowid").all()).toEqual([
    { receipt: "continued" },
    { receipt: "delivered" },
  ]);
  f.finish(lead.id, "");
  await restarted.reconcile(lead);
  expect(await flushInbox(d, lead)).toBe("queued");
  expect(d.store.queued(lead).map((message) => message.text)).toEqual(["Batch B"]);
  expect(await f.rt.confirmedDelivery(lead)).toBeUndefined();
  f.finish(lead.id, "Batch A received.");
  await restarted.reconcile(lead);
  expect(await flushInbox(d, lead)).toBe("delivered");
  expect(d.store.queued(lead)).toEqual([]);
  expect(await f.rt.confirmedDelivery(lead)).toBeUndefined();
  f.finish(lead.id, "Ordinary batch received.");
  await restarted.reconcile(lead);
  expect(await flushInbox(d, lead)).toBe("delivered");
  expect(db.query("SELECT receipt FROM effects ORDER BY rowid").all()).toEqual([
    { receipt: "continued" },
    { receipt: "acknowledged" },
  ]);
  const submissions = db
    .query<{ client: string; turn: string; batch: string | null }, []>("SELECT client,turn,batch FROM submissions")
    .all();
  expect(new Set(submissions.map((row) => row.turn)).size).toBe(submissions.length);
  expect(submissions.filter((row) => row.batch !== null)).toHaveLength(2);
  expect(f.requests.filter((request) => request["method"] === "turn/start")).toHaveLength(5);
});
for (const mismatch of ["actor", "item", "turn", "action", "result", "unclaimed"] as const)
  test("receipt admission refuses mismatched " + mismatch + " without losing the submit lock", async () => {
    const { f, lead, store, connection, thread, source } = await setup();
    using journal = new MessageJournal(store, lead.id);
    const row = journal.effect(source.id);
    if (!row) throw new Error("Missing actual source effect");
    using db = new Database(store.path(lead.id) + ".messages.sqlite");
    if (mismatch !== "unclaimed") db.run("UPDATE effects SET receipt='dispatching'");
    thread.status = { type: "idle" };
    const bound = {
      threadId: mismatch === "actor" ? "foreign" : lead.id,
      turnId: mismatch === "turn" ? "foreign" : row.turn,
      itemId: mismatch === "item" ? "foreign" : row.item,
    };
    const before = f.requests.length;
    await expect(
      deliver(store, connection, lead, mismatch === "result" ? "forged" : row.result, undefined, undefined, undefined, {
        source: bound,
        action: mismatch === "action" ? "{}" : row.body,
      }),
    ).rejects.toMatchObject({ kind: "ownership" });
    expect(f.requests.slice(before).filter((request) => request["method"] === "turn/start")).toEqual([]);
    const release = takeManagedSubmit(store, lead.id);
    expect(release).toBeDefined();
    release?.();
    expect(journal.effect(source.id)?.receipt).toBe(mismatch === "unclaimed" ? "delivered" : "dispatching");
  });
