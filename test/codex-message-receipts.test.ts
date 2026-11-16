import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const setup = async (tool = "dori_status", args: object = {}) => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  await f.rt.startAgent(lead, { prompt: "Inspect the request." });
  const source = f.finish(lead.id, JSON.stringify({ version: 1, kind: "action", tool, arguments: args }));
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const store = new CodexStore(f.root);
  return { f, d, lead, source, store, controller: new MessageController(d, store, connection) };
};

test.each([
  ["client", "client_id"],
  ["input", "input_content"],
  ["failed", "turn_status"],
  ["error", "turn_error"],
  ["interrupted", "turn_status"],
  ["no-user", "user_count"],
  ["two-users", "user_count"],
  ["no-answer", "final_phase"],
  ["phase", "final_phase"],
  ["priority-client", "client_id"],
  ["priority-input", "input_content"],
  ["priority-user", "user_count"],
  ["priority-error", "turn_error"],
  ["unknown-status", "turn_status"],
  ["bounded", "client_id"],
  ["malformed", null],
  ["text-type", null],
  ["multiple-finals", null],
] as const)(
  "receipt %s preserves its original error, identity and no-replay state with bounded diagnostics",
  async (mode, predicate) => {
    const { f, lead, source, store, controller } = await setup();
    await controller.reconcile(lead);
    const thread = f.threads.get(lead.id);
    let receiptTurn = thread?.turns.at(-1);
    if (!receiptTurn) throw new Error("Missing actual accepted receipt turn");
    const originalClient = receiptTurn.items[0]?.["clientId"];
    if (mode === "bounded") {
      if (!thread) throw new Error("Missing receipt thread");
      const originalId = receiptTurn.id;
      receiptTurn = { ...receiptTurn, id: "accepted-" + "x".repeat(700) };
      thread.turns[thread.turns.length - 1] = receiptTurn;
      using writer = new Database(store.path(lead.id) + ".messages.sqlite");
      writer.run("UPDATE effects SET accepted=? WHERE accepted=?", [receiptTurn.id, originalId]);
      writer.run("UPDATE submissions SET turn=? WHERE turn=?", [receiptTurn.id, originalId]);
    }
    const sensitive = "PRIVATE_RESPONSE_OR_CREDENTIAL_SENTINEL";
    f.finish(
      lead.id,
      mode === "malformed" ? '{"kind":"action",' : sensitive,
      mode === "failed"
        ? { status: "failed", error: { code: "fixture-error" } }
        : mode === "error" || mode === "priority-error"
          ? { error: { message: sensitive } }
          : mode === "interrupted"
            ? { status: "interrupted" }
            : undefined,
    );
    const user = receiptTurn.items[0];
    if (!user) throw new Error("Missing canonical receipt user");
    if (mode === "no-answer") receiptTurn.items.splice(1);
    const answer = receiptTurn.items.findLast((item) => item["type"] === "agentMessage");
    if (["client", "bounded", "priority-client", "priority-user", "priority-error"].includes(mode))
      user["clientId"] = sensitive;
    if (["input", "priority-input", "priority-client"].includes(mode))
      user["content"] = [{ type: "text", text: sensitive, text_elements: [] }];
    if (mode === "no-user") receiptTurn.items.splice(0, 1);
    if (mode === "two-users" || mode === "priority-user")
      receiptTurn.items.unshift({ ...user, id: crypto.randomUUID() });
    if (mode === "phase" || mode === "priority-client" || mode === "priority-input") {
      if (!answer) throw new Error("Missing canonical receipt answer");
      answer["phase"] = "commentary";
    }
    if (mode === "unknown-status") Object.defineProperty(receiptTurn, "status", { value: sensitive.repeat(30) });
    if (mode === "text-type") {
      if (!answer) throw new Error("Missing canonical receipt answer");
      answer["text"] = { secret: sensitive };
    }
    if (mode === "multiple-finals")
      receiptTurn.items.push({ id: crypto.randomUUID(), type: "agentMessage", phase: "final_answer", text: sensitive });
    const before = f.requests.length;
    const message =
      mode === "malformed"
        ? "Malformed management JSON final"
        : mode === "text-type"
          ? "Expected Codex text"
          : mode === "multiple-finals"
            ? "Multiple canonical final answers"
            : "Canonical management receipt response changed";
    await expect(controller.reconcile(lead)).rejects.toMatchObject({
      kind: predicate === null ? "protocol" : "uncertain",
      message,
    });
    using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
    expect(db.query("SELECT state,receipt,client,accepted FROM effects").get()).toEqual({
      state: "completed",
      receipt: "uncertain",
      client: originalClient,
      accepted: receiptTurn.id,
    });
    const diagnostic = db.query<{ body: string }, []>("SELECT body FROM progress WHERE kind='receipt/uncertain'").get();
    if (predicate === null) {
      expect(diagnostic).toBeNull();
      expect(db.query("SELECT kind FROM progress WHERE kind='source/refused'").all()).toEqual([
        { kind: "source/refused" },
      ]);
    } else {
      if (!diagnostic) throw new Error("Missing uncertainty diagnostic");
      expect(JSON.parse(diagnostic.body)).toEqual({
        sourceTurn: source.id.slice(0, 256),
        accepted: receiptTurn.id.slice(0, 256),
        predicate,
        status:
          mode === "failed"
            ? "failed"
            : mode === "interrupted"
              ? "interrupted"
              : mode === "unknown-status"
                ? "unknown"
                : "completed",
        error: mode === "failed" || mode === "error" || mode === "priority-error",
      });
      expect(Buffer.byteLength(diagnostic.body)).toBeLessThan(4096);
      expect(diagnostic.body).not.toContain(sensitive);
    }
    await expect(controller.reconcile(lead)).rejects.toThrow("unresolved");
    expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
  },
);

test.each(["Receipt acknowledged.", "", " \t\n"])(
  "completed receipt %j acknowledges delivery once without a new turn",
  async (answer) => {
    const { f, lead, store, controller } = await setup();
    await controller.reconcile(lead);
    const accepted = f.threads.get(lead.id)?.turns.at(-1);
    if (!accepted) throw new Error("Missing actual accepted receipt turn");
    const client = accepted.items[0]?.["clientId"];
    f.finish(lead.id, answer);
    const before = f.requests.length;
    await controller.reconcile(lead);
    await controller.reconcile(lead);
    using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
    expect(db.query("SELECT state,receipt,client,accepted FROM effects").all()).toEqual([
      { state: "completed", receipt: "acknowledged", client, accepted: accepted.id },
    ]);
    expect(db.query("SELECT kind FROM progress WHERE kind='receipt/uncertain'").all()).toEqual([]);
    expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
  },
);
test("a receipt with a validated next action continues and dispatches exactly once", async () => {
  const { f, lead, store, controller } = await setup();
  await controller.reconcile(lead);
  const next = f.finish(lead.id, JSON.stringify({ version: 1, kind: "action", tool: "dori_status", arguments: {} }));
  await controller.reconcile(lead);
  f.finish(lead.id, "");
  await controller.reconcile(lead);
  const before = f.requests.length;
  await controller.reconcile(lead);
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  expect(db.query("SELECT state,receipt FROM effects ORDER BY rowid").all()).toEqual([
    { state: "completed", receipt: "continued" },
    { state: "completed", receipt: "acknowledged" },
  ]);
  expect(db.query("SELECT turn FROM effects ORDER BY rowid").all()).toEqual([
    { turn: f.threads.get(lead.id)?.turns[0]?.id },
    { turn: next.id },
  ]);
  expect(f.requests.filter((frame) => frame["method"] === "turn/start")).toHaveLength(3);
  expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
});

test("an explicit role refusal produces one declined source-bound receipt without claiming rollback", async () => {
  const { f, d, lead, source, store, controller } = await setup("dori_report", {
    text: "A lead cannot impersonate a lane.",
  });
  await controller.reconcile(lead);
  expect(d.store.lanes()).toEqual([]);
  const receiptTurn = f.threads.get(lead.id)?.turns.at(-1);
  const content = receiptTurn?.items[0]?.["content"];
  if (!Array.isArray(content)) throw new Error("Missing actual declined receipt input");
  expect(JSON.parse(content[0].text)).toMatchObject({
    kind: "dori_receipt",
    ok: false,
    source: { threadId: lead.id, turnId: source.id, itemId: source.items.at(-1)?.["id"] },
    result: { error: "Tool is not allowed for this role" },
  });
  f.finish(lead.id, "");
  await controller.reconcile(lead);
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  expect(db.query("SELECT state,receipt FROM effects").all()).toEqual([
    { state: "completed", receipt: "acknowledged" },
  ]);
  expect(
    db
      .query<{ result: string }, []>("SELECT result FROM effects")
      .all()
      .map((row) => JSON.parse(row.result).ok),
  ).toEqual([false]);
});

test("an unknown handler failure remains uncertain without generating a success receipt", async () => {
  const { f, d, lead, store, controller } = await setup("dori_start", { key: "audit" });
  const before = f.requests.length;
  await expect(controller.reconcile(lead)).rejects.toThrow();
  expect(d.store.lanes()).toEqual([]);
  using db = new Database(store.path(lead.id) + ".messages.sqlite", { readonly: true });
  expect(db.query("SELECT state,receipt FROM effects").all()).toEqual([{ state: "uncertain", receipt: "uncertain" }]);
  await expect(controller.reconcile(lead)).rejects.toThrow("unresolved");
  expect(f.requests.slice(before).filter((frame) => frame["method"] === "turn/start")).toEqual([]);
});
