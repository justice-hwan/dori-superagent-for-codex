import { Database } from "bun:sqlite";
import { expect, onTestFinished, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoneTarget } from "../src/runtime/codex/done-target.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import type { ManagementFinal } from "../src/runtime/codex/message-schema.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dori-done-binding-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const store = new CodexStore(root);
  await store.init();
  const source = crypto.randomUUID();
  const final: ManagementFinal = {
    source: { threadId: source, turnId: "turn-done", itemId: "final-done" },
    action: { tool: "dori_done", arguments: { key: "lane-one" } },
  };
  const target: DoneTarget = {
    runtime: "codex",
    id: crypto.randomUUID(),
    cwd: root,
    key: "lane-one",
    createdAt: 123,
    admissionId: "admission-one",
    admissionOrder: 1,
    readyHash: createHash("sha256").update("READY generation one").digest("hex"),
  };
  return { root, store, source, final, target, path: `${store.path(source)}.messages.sqlite` };
}

test("FULL-committed binding is immutable identity, never observation or effect consumption", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  using db = new Database(f.path);
  db.exec(`CREATE TABLE sync_evidence(mode INTEGER);
    CREATE TRIGGER binding_sync BEFORE INSERT ON close_targets BEGIN
      INSERT INTO sync_evidence SELECT synchronous FROM pragma_synchronous;
    END`);
  expect(journal.doneTarget(f.final, f.root)).toBeUndefined();
  const binding = journal.bindDoneTarget(f.final, f.root, f.target);
  expect(binding.action).toBe(JSON.stringify(f.final.action));
  expect(binding.actionHash).toBe(createHash("sha256").update(binding.action).digest("hex"));
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.target)).toBe(true);
  expect(journal.bindDoneTarget(f.final, f.root, { ...f.target })).toEqual(binding);
  expect(journal.seen(f.final.source.turnId)).toBe(false);
  expect(journal.effect(f.final.source.turnId)).toBeUndefined();
  expect(journal.claim()).toBeUndefined();
  expect(() => journal.assertSettled()).not.toThrow();
  expect(db.query("SELECT mode FROM sync_evidence").all()).toEqual([{ mode: 2 }]);
  for (const table of ["observed", "effects", "submissions", "progress"])
    expect(db.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
});

test("a source turn cannot change item, action bytes, actor or workspace or replace its target", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.bindDoneTarget(f.final, f.root, f.target);
  for (const final of [
    { ...f.final, source: { ...f.final.source, itemId: "another-item" } },
    { ...f.final, source: { ...f.final.source, threadId: crypto.randomUUID() } },
    { ...f.final, action: { tool: "dori_done", arguments: { key: "another-key" } } },
    { ...f.final, action: { arguments: { key: "lane-one" }, tool: "dori_done" } },
  ]) {
    expect(() => journal.doneTarget(final, f.root)).toThrow("durable done binding");
    expect(() => journal.bindDoneTarget(final, f.root, f.target)).toThrow("durable done binding");
  }
  expect(() => journal.doneTarget(f.final, join(f.root, "other"))).toThrow("durable done binding");
  expect(() => journal.bindDoneTarget(f.final, join(f.root, "other"), f.target)).toThrow();
  for (const target of [
    { ...f.target, id: crypto.randomUUID() },
    { ...f.target, cwd: join(f.root, "other") },
    { ...f.target, createdAt: 124 },
    { ...f.target, admissionId: "new-admission" },
    { ...f.target, admissionOrder: 2 },
    { ...f.target, readyHash: "a".repeat(64) },
    { ...f.target, admissionId: null, admissionOrder: null },
  ])
    expect(() => journal.bindDoneTarget(f.final, f.root, target)).toThrow("durable done binding");
  expect(journal.doneTarget(f.final, f.root)).toEqual(binding);
  expect(journal.seen(f.final.source.turnId)).toBe(false);
});

test("done reservation requires the exact persisted binding and failed effect insert remains unconsumed", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  expect(() => journal.reserve(f.final)).toThrow("durable done binding");
  const binding = journal.bindDoneTarget(f.final, f.root, f.target);
  expect(() => journal.reserve(f.final)).toThrow("durable done binding");
  expect(() => journal.reserve(f.final, { ...binding, target: { ...f.target, id: crypto.randomUUID() } })).toThrow();
  expect(() => journal.reserve(f.final, { ...binding, sourceCwd: join(f.root, "other") })).toThrow();
  using db = new Database(f.path);
  db.exec("CREATE TRIGGER refuse_effect BEFORE INSERT ON effects BEGIN SELECT RAISE(FAIL,'effect fault'); END");
  expect(() => journal.reserve(f.final, binding)).toThrow("effect fault");
  expect(journal.seen(f.final.source.turnId)).toBe(false);
  expect(journal.doneTarget(f.final, f.root)).toEqual(binding);
  db.exec("DROP TRIGGER refuse_effect");
  expect(journal.reserve(f.final, binding)).toBe("new");
  expect(journal.reserve(f.final, binding)).toBe("existing");
  expect(journal.effect(f.final.source.turnId)?.state).toBe("dispatching");
});

test("restart reopens the original binding without rebinding or making reserved work retryable", async () => {
  const f = await fixture();
  {
    using journal = new MessageJournal(f.store, f.source);
    journal.bindDoneTarget(f.final, f.root, f.target);
  }
  using journal = new MessageJournal(f.store, f.source);
  const binding = journal.doneTarget(f.final, f.root);
  expect(binding?.target).toEqual(f.target);
  expect(() => journal.bindDoneTarget(f.final, f.root, { ...f.target, id: crypto.randomUUID() })).toThrow();
  expect(journal.reserve(f.final, binding)).toBe("new");
  expect(() => journal.assertSettled()).toThrow("never replay");
  journal.uncertain(f.final, "possible close");
  expect(journal.reserve(f.final, binding)).toBe("existing");
  expect(() => journal.assertSettled()).toThrow("never replay");
  journal.complete(f.final, { closed: true }, false);
  const receipt = journal.claim();
  if (!receipt) throw new Error("Missing actual completed receipt");
  journal.settle(receipt, "delivered", { client: "accepted-client", turn: "accepted-turn", inputHash: "input" });
  expect(journal.reserve(f.final, binding)).toBe("existing");
  expect(journal.effect(f.final.source.turnId)).toMatchObject({
    state: "completed",
    receipt: "delivered",
    accepted: "accepted-turn",
  });
});

test("non-done tools preserve ordinary reservation without any target binding", async () => {
  const f = await fixture();
  using journal = new MessageJournal(f.store, f.source);
  const final = { ...f.final, action: { tool: "dori_report", arguments: { text: "working" } } };
  expect(journal.reserve(final)).toBe("new");
  expect(journal.reserve(final)).toBe("existing");
  expect(journal.doneTarget(final, f.root)).toBeUndefined();
});

test("explicit absence of admission generation survives reopen", async () => {
  const f = await fixture();
  const target = { ...f.target, admissionId: null, admissionOrder: null };
  {
    using journal = new MessageJournal(f.store, f.source);
    journal.bindDoneTarget(f.final, f.root, target);
  }
  using journal = new MessageJournal(f.store, f.source);
  expect(journal.doneTarget(f.final, f.root)?.target).toEqual(target);
});
