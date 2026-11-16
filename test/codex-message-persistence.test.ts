import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { fixture } from "./codex-fixture.test.ts";

test("actual product submission records its client intent before dispatch and accepted identity on response", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const path = new CodexStore(f.root).path(ref.id) + ".messages.sqlite";
  let intent: unknown;
  f.onRequest((request) => {
    if (request["method"] !== "turn/start") return;
    using db = new Database(path, { readonly: true });
    intent = db.query("SELECT client,inputHash,state,at FROM submissions").get();
  });
  expect(await f.rt.deliver(ref, "One exact task.")).toMatchObject({ kind: "delivered" });
  const turn = f.threads.get(ref.id)?.turns[0];
  if (!turn) throw new Error("Missing actual canonical admission");
  const user = turn.items[0];
  const hash = createHash("sha256")
    .update(JSON.stringify([{ type: "text", text: "One exact task.", text_elements: [] }]))
    .digest("hex");
  expect(intent).toMatchObject({
    client: user?.["clientId"],
    inputHash: hash,
    state: "intent",
    at: expect.any(Number),
  });
  using db = new Database(path, { readonly: true });
  expect(db.query("SELECT client,turn,state,acceptedAt FROM submissions").get()).toMatchObject({
    client: user?.["clientId"],
    turn: turn.id,
    state: "accepted",
    acceptedAt: expect.any(Number),
  });
});

test("post-acceptance persistence failure preserves the known turn and never resubmits", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const store = new CodexStore(f.root),
    path = store.path(ref.id) + ".messages.sqlite";
  f.onAdmission(() => {
    using db = new Database(path);
    db.exec(
      "CREATE TRIGGER refuse_accept BEFORE UPDATE ON submissions WHEN NEW.state='accepted' BEGIN SELECT RAISE(FAIL,'fixture accepted-record fault'); END",
    );
  });
  expect((await f.rt.deliver(ref, "Only once.")).kind).toBe("ambiguous");
  const turn = f.threads.get(ref.id)?.turns[0];
  if (!turn) throw new Error("Wire peer did not accept the submission");
  const before = f.requests.length;
  expect((await f.rt.deliver(ref, "Never automatically resend.")).kind).toBe("ambiguous");
  expect(f.requests.slice(before)).toEqual([]);
  expect(f.threads.get(ref.id)?.turns).toHaveLength(1);
  expect((await store.owned(ref)).uncertain).toContain("may have been accepted");
  using db = new Database(path, { readonly: true });
  expect(db.query("SELECT state,client,turn,acceptedAt FROM submissions").get()).toMatchObject({
    state: "uncertain",
    client: turn.items[0]?.["clientId"],
    turn: turn.id,
    acceptedAt: expect.any(Number),
  });
});

test("intent persistence refusal prevents the product model dispatch", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const store = new CodexStore(f.root);
  const journal = new MessageJournal(store, ref.id);
  try {
    using db = new Database(store.path(ref.id) + ".messages.sqlite");
    db.exec(
      "CREATE TRIGGER refuse_intent BEFORE INSERT ON submissions BEGIN SELECT RAISE(FAIL,'fixture intent-record fault'); END",
    );
    const before = f.requests.length;
    await expect(f.rt.deliver(ref, "Must not dispatch.")).rejects.toThrow("intent-record fault");
    expect(f.requests.slice(before).filter((request) => request["method"] === "turn/start")).toEqual([]);
    expect(f.threads.get(ref.id)?.turns).toEqual([]);
  } finally {
    journal[Symbol.dispose]();
  }
});
