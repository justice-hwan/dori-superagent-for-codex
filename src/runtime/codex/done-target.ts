import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { Database } from "bun:sqlite";
import type { ManagementFinal } from "./message-schema.ts";
import { CodexError } from "./protocol.ts";

export type DoneTarget = {
  readonly runtime: "codex";
  readonly id: string;
  readonly cwd: string;
  readonly key: string;
  readonly createdAt: number;
  readonly admissionId: string | null;
  readonly admissionOrder: number | null;
  readonly readyHash: string;
};
export type DoneBinding = {
  readonly sourceThread: string;
  readonly turn: string;
  readonly item: string;
  readonly action: string;
  readonly actionHash: string;
  readonly sourceCwd: string;
  readonly target: DoneTarget;
};

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
function invalid(): never {
  throw new CodexError("uncertain", "Missing, malformed or changed durable done binding");
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function workspace(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path)) return invalid();
  return path;
}
function digest(value: unknown): string {
  const parsed = text(value);
  if (!HASH.test(parsed)) return invalid();
  return parsed;
}
function targetOf(value: unknown): DoneTarget {
  const target = record(value);
  const id = text(target["id"]);
  if (Object.keys(target).length !== 8 || target["runtime"] !== "codex" || !ID.test(id)) return invalid();
  const admissionId = target["admissionId"] === null ? null : text(target["admissionId"]);
  const admissionOrder = target["admissionOrder"] === null ? null : number(target["admissionOrder"]);
  if ((admissionId === null) !== (admissionOrder === null)) return invalid();
  return Object.freeze({
    runtime: "codex",
    id,
    cwd: workspace(target["cwd"]),
    key: text(target["key"]),
    createdAt: number(target["createdAt"]),
    admissionId,
    admissionOrder,
    readyHash: digest(target["readyHash"]),
  });
}
export function parseDoneBinding(value: unknown): DoneBinding {
  const row = record(value);
  if (Object.keys(row).length !== 7) return invalid();
  const sourceThread = text(row["sourceThread"]);
  const action = text(row["action"]);
  const actionHash = digest(row["actionHash"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(action);
  } catch {
    return invalid();
  }
  const request = record(parsed);
  const args = record(request["arguments"]);
  const target = targetOf(row["target"]);
  if (
    !ID.test(sourceThread) ||
    sourceThread === target.id ||
    request["tool"] !== "dori_done" ||
    Object.keys(request).length !== 2 ||
    Object.keys(args).length !== 1 ||
    args["key"] !== target.key ||
    actionHash !== hash(action)
  )
    return invalid();
  return Object.freeze({
    sourceThread,
    turn: text(row["turn"]),
    item: text(row["item"]),
    action,
    actionHash,
    sourceCwd: workspace(row["sourceCwd"]),
    target,
  });
}

/** Private intent store; callers own the source submission boundary. Rows never consume a turn. */
export class DoneTargets {
  constructor(
    private readonly db: Database,
    private readonly sourceThread: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS close_targets(
      turn TEXT PRIMARY KEY,version INTEGER NOT NULL,binding TEXT NOT NULL)`);
  }
  private source(final: ManagementFinal, sourceCwd: string, target: DoneTarget): DoneBinding {
    if (final.source.threadId !== this.sourceThread) return invalid();
    const action = JSON.stringify(final.action);
    return parseDoneBinding({
      sourceThread: final.source.threadId,
      turn: final.source.turnId,
      item: final.source.itemId,
      action,
      actionHash: hash(action),
      sourceCwd,
      target,
    });
  }
  read(final: ManagementFinal, sourceCwd: string): DoneBinding | undefined {
    if (final.source.threadId !== this.sourceThread) return invalid();
    const value = this.db.query("SELECT * FROM close_targets WHERE turn=?").get(final.source.turnId);
    if (value === null) return undefined;
    const row = record(value);
    if (row["version"] !== 1) return invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text(row["binding"]));
    } catch {
      return invalid();
    }
    const binding = parseDoneBinding(parsed);
    const expected = this.source(final, sourceCwd, binding.target);
    if (row["turn"] !== binding.turn || JSON.stringify(binding) !== JSON.stringify(expected)) return invalid();
    return binding;
  }
  bind(final: ManagementFinal, sourceCwd: string, target: DoneTarget): DoneBinding {
    const binding = this.source(final, sourceCwd, target);
    return this.db
      .transaction(() => {
        const old = this.read(final, sourceCwd);
        if (old) {
          if (JSON.stringify(old) !== JSON.stringify(binding)) return invalid();
          return old;
        }
        this.db.run("INSERT INTO close_targets(turn,version,binding) VALUES(?,1,?)", [
          binding.turn,
          JSON.stringify(binding),
        ]);
        return binding;
      })
      .immediate();
  }
  verify(final: ManagementFinal, value: unknown): void {
    const binding = parseDoneBinding(value);
    const stored = this.read(final, binding.sourceCwd);
    if (!stored || JSON.stringify(stored) !== JSON.stringify(binding)) invalid();
  }
}
