import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { sameSession } from "./refs.ts";
import { reserveJob } from "./runtime/codex/bridge-jobs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Lane, QueuedMessage } from "./store-types.ts";

export function identifiedInbox(d: Deps, ref: SessionRef): QueuedMessage[] {
  const messages = d.store.queued(ref);
  if ((ref.runtime === "codex" || d.store.laneBySession(ref)) && messages.some((message) => !message.deliveryId))
    return d.store.updateInbox(ref, (current) =>
      current.map((message) => ({ ...message, deliveryId: message.deliveryId ?? crypto.randomUUID() })),
    );
  return messages;
}

export function batchIdentity(messages: readonly QueuedMessage[]): string {
  const ids = messages.map((message) => message.deliveryId ?? [message.at, message.from, message.text]);
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(ids)).digest("hex");
}

/** Lane enqueue and closure use the same lock; role inboxes retain their concurrent append contract. */
export function enqueueInstructions(d: Deps, ref: SessionRef, message: QueuedMessage): void {
  const lane = d.store.lanes().find((entry) => sameSession(entry.sessionRef, ref));
  const release = lane ? d.store.lockInbox(ref, d.now()) : undefined;
  if (lane && !release) throw new Refusal(`lane ${lane.key} inbox is busy; try again`);
  try {
    const current = lane && d.store.lane(lane.key);
    if (current?.status === "done" || current?.status === "lost")
      throw new Refusal(`lane ${current.key} is ${current.status}`);
    reserveJob(d.store, ref, message.text);
    d.store.enqueue(ref, lane ? { ...message, deliveryId: message.deliveryId ?? crypto.randomUUID() } : message);
  } finally {
    release?.();
  }
}

/** Called under the inbox lock, once per admitted batch, before dropping its queued messages. */
export function admitLane(d: Deps, ref: SessionRef, admissionId: string): void {
  const lane = d.store.laneBySession(ref);
  if (!lane || lane.status === "lost" || lane.admissionId === admissionId) return;
  recordAdmission(d, lane, admissionId);
}

function recordAdmission(d: Deps, lane: Lane, admissionId: string): void {
  lane.admissionId = admissionId;
  if (lane.status === "ready") lane.status = "working";
  delete lane.final;
  d.store.saveLane(lane);
}

export function admitMessages(d: Deps, ref: SessionRef, messages: readonly QueuedMessage[]): void {
  const lane = d.store.laneBySession(ref);
  // A successful new attempt (including explicit resend) needs new READY even when message IDs are unchanged.
  if (lane && lane.status !== "lost") recordAdmission(d, lane, batchIdentity(messages));
}

/** Operator acknowledgement and fresh READY reconcile the same held batch under its inbox lock. */
export function admitHeld(d: Deps, ref: SessionRef, message: QueuedMessage): void {
  const lane = d.store.laneBySession(ref);
  if (!lane || lane.status === "lost") return;
  if (!message.deliveryId) throw new TypeError("Held lane message is missing its stable identity");
  const held = d.store.queued(ref).find((entry) => entry.deliveryId === message.deliveryId);
  if (held?.attempt?.state !== "ambiguous" || held.attempt.admission?.recorded) return;
  // Legacy held entries have no attempted-batch metadata: the selected entry is the acknowledged unit.
  const admissionId = held.attempt.admission?.id ?? batchIdentity([held]);
  admitLane(d, ref, admissionId);
  d.store.updateInbox(ref, (current) =>
    current.map((entry) => {
      const sameBatch = held.attempt?.admission
        ? entry.attempt?.admission?.id === admissionId
        : entry.deliveryId === held.deliveryId;
      return sameBatch && entry.attempt?.state === "ambiguous"
        ? { ...entry, attempt: { ...entry.attempt, admission: { id: admissionId, recorded: true } } }
        : entry;
    }),
  );
}
