import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireFileLease } from "./lock.ts";
import { MessengerJournal, sendMessenger, type MessengerConfig, type MessengerOrigin } from "./messenger.ts";
import { flushInbox, Refusal, type Deps } from "./harness.ts";

export type Notice = { id: string; task: string; instance: string; revision: number; kind: "completion" | "decision" | "failure"; summary: string; decision: string; details: string[]; at: number; batch?: string; acknowledgedAt?: number; origin?: MessengerOrigin; externalReceipt?: string };
type Batch = { id: string; ids: string[]; message: { id: string; at: number; from: string; text: string }; target: string; submittedAt?: number };
type Journal = { notices: Notice[]; batches: Batch[] };
const path = (d: Deps) => join(d.store.root, "notifications.json");
function read(d: Deps): Journal { return existsSync(path(d)) ? JSON.parse(readFileSync(path(d), "utf8")) : { notices: [], batches: [] }; }
function save(d: Deps, j: Journal): void { const p = path(d), tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, p); }
function completionCommitted(d: Deps, n: Notice): boolean {
  if (n.kind !== "completion") return true;
  const current = d.store.lane(n.task);
  return !!current && (current.threadId !== n.instance || current.status === "done");
}
const lease = (d: Deps) => { const l = acquireFileLease(path(d) + ".lock"); if (!l) throw new Refusal("notification journal is busy; retry after current update"); return l; };
export function notices(d: Deps): Journal { return read(d); }
export function recordNotice(d: Deps, n: Omit<Notice, "id" | "at" | "batch" | "acknowledgedAt">, identity?: string, at = d.now()): Notice | undefined {
  if (!d.store.roles().conversation) return; // Legacy lead-only mode keeps its existing behavior.
  if (!n.summary.trim() || !Number.isSafeInteger(n.revision) || n.revision < 1) throw new Refusal("notice needs a summary and task revision");
  const originFile = join(d.store.root, "messenger", "journal.json");
  const captured = existsSync(originFile) ? new MessengerJournal(d.store.root).origin(n.instance) : undefined;
  n = { ...n, ...(captured ? { origin: captured } : {}) };
  const id = identity ?? createHash("sha256").update(JSON.stringify(n)).digest("hex");
  const lock = lease(d);
  try {
    const j = read(d), previous = j.notices.find(x => x.id === id);
    if (previous) {
      const fields = ({ id: _id, at: _at, batch: _batch, acknowledgedAt: _ack, externalReceipt: _external, ...x }: Notice) => JSON.stringify(x);
      if (fields(previous) !== JSON.stringify(n)) throw new Refusal("notification identity conflict");
      return previous;
    }
    const value = { ...n, id, at }; j.notices.push(value); save(d, j); return value;
  } finally { lock.release(); }
}
/** Batch quiet completions after five seconds; urgent decisions/failures never pull unrelated completions forward. */
export async function flushNotices(d: Deps, force = false): Promise<boolean> {
  if (!d.store.roles().conversation) return true;
  const lock = lease(d);
  try {
    const j = read(d);
    let batch = j.batches.find(b => !b.submittedAt);
    if (!batch) {
      const pending = j.notices.filter(n => !n.batch && !n.acknowledgedAt && !n.origin && completionCommitted(d, n));
      const urgent = pending.filter(n => n.kind !== "completion");
      const chosen = (urgent.length ? urgent : pending.filter(n => force || d.now() - n.at >= 5000)).slice(0, 8);
      if (!chosen.length) return true;
      const id = randomUUID();
      const lines = chosen.map(n => `- ${n.summary.slice(0, 300)}${n.kind === "decision" ? `\n  정할 것: ${n.decision.slice(0, 300)}` : ""}${n.details.length ? `\n  ${n.details[0]}` : ""}`);
      const text = `[도리 업무 보고]\n${lines.join("\n")}`;
      batch = { id, ids: chosen.map(n => n.id), target: d.store.roles().conversation!, message: { id: `notice-${id}`, at: d.now(), from: "work-lead", text } };
      for (const n of chosen) n.batch = id;
      j.batches.push(batch); save(d, j); // Write ahead of durable inbox admission.
    }
    d.store.enqueueOnce(batch.target, batch.message);
    await flushInbox(d, batch.target);
    if (d.store.queued(batch.target).some(m => m.id === batch!.message.id)) return false;
    batch.submittedAt = d.now(); save(d, j); return true;
  } finally { lock.release(); }
}
export function acknowledgeNotice(d: Deps, id: string): void {
  const lock = lease(d);
  try {
    const j = read(d), b = j.batches.find(x => x.id === id);
    const selected = b ? j.notices.filter(n => b.ids.includes(n.id)) : j.notices.filter(n => n.id === id);
    if (!selected.length || (b && !b.submittedAt)) throw new Refusal("notification is missing or has not confirmed submission");
    for (const n of selected) n.acknowledgedAt ??= d.now();
    save(d, j);
  } finally { lock.release(); }
}

/** Explicit configured delivery only. External origins never fall back to the Codex conversation. */
export async function deliverExternalNotice(d: Deps, id: string, config: MessengerConfig & { account: string; workspace?: string }): Promise<string> {
  const lock = lease(d);
  try {
    const j = read(d), n = j.notices.find(x => x.id === id);
    if (n && !completionCommitted(d, n)) throw new Refusal("completion is not committed in the task ledger");
    if (!n?.origin) throw new Refusal("notice has no captured messenger origin");
    if (config.platform !== n.origin.platform || config.account !== n.origin.account || config.workspace !== n.origin.workspace) throw new Refusal("configured messenger account does not match the captured origin");
    const text = `${n.task} r${n.revision}: ${n.summary}\n${n.decision ? `정할 것: ${n.decision}\n` : ""}${n.details.join("\n")}`;
    const receipt = await new MessengerJournal(d.store.root).reply(n.instance, n.id, text, origin => sendMessenger({ ...config, ...origin, text }));
    if (receipt.state !== "sent" || !receipt.messageId) throw new Refusal("external delivery unconfirmed");
    n.externalReceipt = receipt.messageId; save(d, j); return receipt.messageId;
  } finally { lock.release(); }
}
