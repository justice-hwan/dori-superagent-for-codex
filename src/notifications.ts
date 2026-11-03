import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { acquireFileLease } from "./lock.ts";
import { MessengerJournal, sendMessenger, type MessengerConfig, type MessengerOrigin } from "./messenger.ts";
import type { Completion, TaskOrigin } from "./store.ts";
import { flushInbox, Refusal, type Deps } from "./harness.ts";

export type Notice = { id: string; task: string; instance: string; revision: number; kind: "completion" | "decision" | "failure"; summary: string; decision: string; details: string[]; at: number; batch?: string; acknowledgedAt?: number; origin?: MessengerOrigin; externalReceipt?: string; route?: TaskOrigin };
type Batch = { id: string; ids: string[]; message: { id: string; at: number; from: string; text: string }; target: string; submittedAt?: number };
type Journal = { notices: Notice[]; batches: Batch[] };
const path = (d: Deps) => join(d.store.root, "notifications.json");
function read(d: Deps): Journal { return existsSync(path(d)) ? JSON.parse(readFileSync(path(d), "utf8")) : { notices: [], batches: [] }; }
function save(d: Deps, j: Journal): void { const p = path(d), tmp = `${p}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, p); }
function receipt(d: Deps, n: Pick<Notice, "task" | "instance" | "revision">): Completion | undefined {
  return d.store.lane(n.task)?.completions?.find(r => r.task === n.task && r.instance === n.instance && r.revision === n.revision);
}
function completionCommitted(d: Deps, n: Notice): boolean {
  if (n.kind !== "completion") return true;
  const committed = receipt(d, n);
  return !!committed && committed.summary === n.summary && committed.decision === n.decision && JSON.stringify(committed.details) === JSON.stringify(n.details) && JSON.stringify(committed.origin) === JSON.stringify(n.route);
}
const lease = (d: Deps) => { const l = acquireFileLease(path(d) + ".lock"); if (!l) throw new Refusal("notification journal is busy; retry after current update"); return l; };
export function notices(d: Deps): Journal { return read(d); }
export function recordNotice(d: Deps, n: Omit<Notice, "id" | "at" | "batch" | "acknowledgedAt">, identity?: string, at = d.now()): Notice | undefined {
  if (!d.store.roles().conversation) return; // Legacy lead-only mode keeps its existing behavior.
  if (!n.summary.trim() || !Number.isSafeInteger(n.revision) || n.revision < 1) throw new Refusal("notice needs a summary and task revision");
  const committed = n.kind === "completion" ? receipt(d, n) : undefined;
  const current = d.store.lane(n.task);
  const route: TaskOrigin = committed?.origin ?? (current?.threadId === n.instance && (current.revision ?? 1) === n.revision ? current.origin : undefined) ?? { kind: "unknown" };
  if (n.kind === "completion" && !committed) throw new Refusal("completion has no committed exact instance/revision receipt");
  n = { ...n, route, ...(route.kind === "messenger" ? { origin: route.origin } : {}) };
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
    let batch = j.batches.find(b => b.submittedAt === undefined);
    if (!batch) {
      const pending = j.notices.filter(n => !n.batch && !n.acknowledgedAt && n.route?.kind === "codex" && n.route.threadId === d.store.roles().conversation && completionCommitted(d, n));
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
    if (!validNoticeBatch(d, batch.id, batch.target)) throw new Refusal("notification batch route or completion proof is unconfirmed; retained for inspection");
    d.store.enqueueOnce(batch.target, batch.message);
    await flushInbox(d, batch.target);
    if (d.store.queued(batch.target).some(m => m.id === batch!.message.id)) return false;
    batch.submittedAt = d.now(); save(d, j); return true;
  } finally { lock.release(); }
}
export function validNoticeBatch(d: Deps, id: string, target: string): boolean {
  const j = read(d), batch = j.batches.find(b => b.id === id);
  if (!batch || batch.target !== target || target !== d.store.roles().conversation || !batch.ids.length || new Set(batch.ids).size !== batch.ids.length) return false;
  const selected = j.notices.filter(n => batch.ids.includes(n.id));
  return selected.length === batch.ids.length && selected.every(n => n.batch === id && n.route?.kind === "codex" && n.route.threadId === target && completionCommitted(d, n));
}
export function acknowledgeNotice(d: Deps, id: string): void {
  const lock = lease(d);
  try {
    const j = read(d), b = j.batches.find(x => x.id === id);
    if (!b || typeof b.submittedAt !== "number" || !Number.isFinite(b.submittedAt) || b.target !== d.store.roles().conversation) throw new Refusal("receipt requires a confirmed submitted batch for this conversation");
    const selected = j.notices.filter(n => b.ids.includes(n.id));
    if (!validNoticeBatch(d, b.id, b.target) || !selected.length || selected.length !== b.ids.length || selected.some(n => n.batch !== b.id || n.route?.kind !== "codex" || n.route.threadId !== b.target)) throw new Refusal("submitted batch does not match its captured notification route");
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
    if (!n?.origin || n.route?.kind !== "messenger" || JSON.stringify(n.route.origin) !== JSON.stringify(n.origin)) throw new Refusal("notice has no captured messenger origin");
    if (config.platform !== n.origin.platform || config.account !== n.origin.account || config.workspace !== n.origin.workspace) throw new Refusal("configured messenger account does not match the captured origin");
    const text = `${n.task} r${n.revision}: ${n.summary}\n${n.decision ? `정할 것: ${n.decision}\n` : ""}${n.details.join("\n")}`;
    const receipt = await new MessengerJournal(d.store.root).reply(n.instance, n.id, text, origin => sendMessenger({ ...config, ...origin, text }));
    if (receipt.state !== "sent" || !receipt.messageId) throw new Refusal("external delivery unconfirmed");
    n.externalReceipt = receipt.messageId; save(d, j); return receipt.messageId;
  } finally { lock.release(); }
}
