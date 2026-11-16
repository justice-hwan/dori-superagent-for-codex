import { Database } from "bun:sqlite";
import type { DeliveryBatch } from "../types.ts";
import { CodexError, object } from "./protocol.ts";
import type { CodexStore } from "./store.ts";
import type { ManagementFinal, MessageSource } from "./message-schema.ts";
import { DoneTargets, type DoneBinding, type DoneTarget } from "./done-target.ts";

export type MessageEffect = {
  readonly turn: string;
  readonly item: string;
  readonly body: string;
  readonly state: "dispatching" | "completed" | "uncertain";
  readonly receipt:
    | "queued"
    | "dispatching"
    | "delivered"
    | "acknowledged"
    | "continued"
    | "locally-settled"
    | "uncertain";
  readonly result: string;
  readonly client: string;
  readonly accepted: string;
};
export type AcceptedSubmission = { readonly client: string; readonly turn: string; readonly inputHash: string };

/** One protected journal per actor. FULL commits precede crossing effect or submission boundaries. */
export class MessageJournal {
  private readonly db: Database;
  private readonly doneTargets: DoneTargets;
  constructor(store: CodexStore, threadId: string) {
    this.db = new Database(`${store.path(threadId)}.messages.sqlite`, { create: true, strict: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS effects(turn TEXT PRIMARY KEY,item TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,
        receipt TEXT NOT NULL,result TEXT NOT NULL,client TEXT NOT NULL,accepted TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observed(turn TEXT PRIMARY KEY,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions(client TEXT PRIMARY KEY,inputHash TEXT NOT NULL,batch TEXT,source TEXT,
        state TEXT NOT NULL,turn TEXT NOT NULL,at INTEGER NOT NULL,acceptedAt INTEGER,error TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS progress(seq INTEGER PRIMARY KEY,at INTEGER NOT NULL,monotonic REAL NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);`);
    this.doneTargets = new DoneTargets(this.db, threadId);
  }
  [Symbol.dispose](): void {
    this.db.close();
  }
  seen(turn: string): boolean {
    return (
      this.db
        .query("SELECT turn FROM observed WHERE turn=? UNION SELECT turn FROM effects WHERE turn=?")
        .get(turn, turn) !== null
    );
  }
  observe(turn: string, reason: string): void {
    this.db.run("INSERT OR IGNORE INTO observed VALUES(?,?)", [turn, reason]);
  }
  effect(turn: string): MessageEffect | undefined {
    return this.db.query<MessageEffect, [string]>("SELECT * FROM effects WHERE turn=?").get(turn) ?? undefined;
  }
  receiptFor(turn: string): MessageEffect | undefined {
    return (
      this.db
        .query<MessageEffect, [string]>("SELECT * FROM effects WHERE accepted=? AND receipt='delivered'")
        .get(turn) ?? undefined
    );
  }
  /** Receipt occupancy survives lock release and restart until canonical response validation. */
  admit(
    threadId: string,
    prompt: string,
    receipt?: { readonly source: MessageSource; readonly action: string },
  ): boolean {
    const pending = this.db
      .query<MessageEffect, []>(
        "SELECT * FROM effects WHERE state!='completed' OR receipt IN ('queued','dispatching','delivered','uncertain') ORDER BY rowid",
      )
      .all();
    if (!receipt) return pending.length === 0;
    const row = this.effect(receipt.source.turnId);
    if (
      receipt.source.threadId !== threadId ||
      !row ||
      row.state !== "completed" ||
      row.receipt !== "dispatching" ||
      row.item !== receipt.source.itemId ||
      row.body !== receipt.action ||
      row.result !== prompt
    )
      throw new CodexError("ownership", "Receipt admission identity changed");
    const result = object(JSON.parse(row.result)),
      source = object(result["source"]);
    if (
      result["version"] !== 1 ||
      result["kind"] !== "dori_receipt" ||
      source["threadId"] !== threadId ||
      source["turnId"] !== row.turn ||
      source["itemId"] !== row.item
    )
      throw new CodexError("ownership", "Receipt result source changed");
    return (
      pending[0]?.turn === row.turn &&
      pending.slice(1).every((effect) => effect.state === "completed" && effect.receipt === "queued")
    );
  }
  assertSettled(): void {
    if (
      this.db
        .query("SELECT turn FROM effects WHERE state!='completed' OR receipt IN ('dispatching','uncertain') LIMIT 1")
        .get()
    )
      throw new CodexError("uncertain", "Management effect or receipt is unresolved; never replay it");
  }
  doneTarget(final: ManagementFinal, sourceCwd: string): DoneBinding | undefined {
    return this.doneTargets.read(final, sourceCwd);
  }
  bindDoneTarget(final: ManagementFinal, sourceCwd: string, target: DoneTarget): DoneBinding {
    return this.doneTargets.bind(final, sourceCwd, target);
  }
  reserve(final: ManagementFinal, binding?: DoneBinding): "new" | "existing" {
    return this.db
      .transaction(() => {
        if (final.action.tool === "dori_done") this.doneTargets.verify(final, binding);
        const body = JSON.stringify(final.action);
        const old = this.db
          .query<MessageEffect, [string]>("SELECT * FROM effects WHERE turn=?")
          .get(final.source.turnId);
        if (old) {
          if (old.item !== final.source.itemId || old.body !== body)
            throw new CodexError("uncertain", "Canonical management source changed");
          return "existing" as const;
        }
        this.assertSettled();
        this.db.run("INSERT INTO effects VALUES(?,?,?,'dispatching','queued','','','')", [
          final.source.turnId,
          final.source.itemId,
          body,
        ]);
        return "new" as const;
      })
      .immediate();
  }
  complete(final: ManagementFinal, result: unknown, terminal: boolean, ok = true): void {
    const receipt = JSON.stringify({ version: 1, kind: "dori_receipt", source: final.source, ok, result });
    if (Buffer.byteLength(receipt) > 65536) throw new CodexError("uncertain", "Management receipt exceeds 64 KiB");
    this.db.run("UPDATE effects SET state='completed',receipt=?,result=? WHERE turn=?", [
      terminal ? "locally-settled" : "queued",
      receipt,
      final.source.turnId,
    ]);
  }
  uncertain(final: ManagementFinal, error: unknown): void {
    this.db.run("UPDATE effects SET state='uncertain',receipt='uncertain',result=? WHERE turn=?", [
      JSON.stringify({ source: final.source, error: error instanceof Error ? error.message : String(error) }),
      final.source.turnId,
    ]);
  }
  claim(): MessageEffect | undefined {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<MessageEffect, []>(
            "SELECT * FROM effects WHERE state='completed' AND receipt='queued' ORDER BY rowid LIMIT 1",
          )
          .get();
        if (row) this.db.run("UPDATE effects SET receipt='dispatching' WHERE turn=?", [row.turn]);
        return row ?? undefined;
      })
      .immediate();
  }
  settle(row: MessageEffect, receipt: "queued" | "delivered" | "uncertain", submission?: AcceptedSubmission): void {
    if (submission)
      this.db.run("UPDATE effects SET receipt=?,client=?,accepted=? WHERE turn=?", [
        receipt,
        submission.client,
        submission.turn,
        row.turn,
      ]);
    else this.db.run("UPDATE effects SET receipt=? WHERE turn=?", [receipt, row.turn]);
  }
  respond(row: MessageEffect, continued: boolean): void {
    this.db.run("UPDATE effects SET receipt=? WHERE turn=?", [continued ? "continued" : "acknowledged", row.turn]);
  }
  intend(client: string, inputHash: string, batch?: DeliveryBatch, source?: MessageSource): void {
    this.db.run("INSERT INTO submissions VALUES(?,?,?,?,'intent','',?,NULL,'')", [
      client,
      inputHash,
      batch ? JSON.stringify(batch) : null,
      source ? JSON.stringify(source) : null,
      Date.now(),
    ]);
    this.note("submission/intent", { client, inputHash, batch, source });
  }
  accept(client: string, turn: string, at: number): void {
    this.db.run("UPDATE submissions SET state='accepted',turn=?,acceptedAt=? WHERE client=?", [turn, at, client]);
    this.note("submission/accepted", { client, turn });
  }
  fail(
    client: string,
    error: unknown,
    ambiguous: boolean,
    accepted?: { readonly turn: string; readonly at: number },
  ): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.db.run(
      "UPDATE submissions SET state=?,error=?,turn=COALESCE(?,turn),acceptedAt=COALESCE(?,acceptedAt) WHERE client=?",
      [ambiguous ? "uncertain" : "rejected", detail, accepted?.turn ?? null, accepted?.at ?? null, client],
    );
    this.note("submission/failure", { client, error: detail, accepted });
  }
  accepted(source: MessageSource): AcceptedSubmission | undefined {
    return (
      this.db
        .query<AcceptedSubmission, [string]>(
          "SELECT client,turn,inputHash FROM submissions WHERE source=? AND state='accepted' ORDER BY at DESC LIMIT 1",
        )
        .get(JSON.stringify(source)) ?? undefined
    );
  }
  note(kind: string, value: unknown): void {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 65536) throw new CodexError("protocol", "Management progress exceeds 64 KiB");
    this.db.run("INSERT INTO progress(at,monotonic,kind,body) VALUES(?,?,?,?)", [
      Date.now(),
      performance.now(),
      kind,
      body,
    ]);
  }
}
