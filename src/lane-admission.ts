import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { sameSession } from "./refs.ts";
import { reserveJob } from "./runtime/codex/bridge-jobs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { QueuedMessage } from "./store-types.ts";

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
  lane.admissionId = admissionId;
  if (lane.status === "ready") lane.status = "working";
  delete lane.final;
  d.store.saveLane(lane);
}

export function admitMessages(d: Deps, ref: SessionRef, messages: readonly QueuedMessage[]): void {
  const ids = messages.map((message) => message.deliveryId ?? [message.at, message.from, message.text]);
  admitLane(d, ref, new Bun.CryptoHasher("sha256").update(JSON.stringify(ids)).digest("hex"));
}
