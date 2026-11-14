import type { Deps } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { sameSession } from "./refs.ts";
import { reserveJob } from "./runtime/codex/bridge-jobs.ts";
import type { SessionRef } from "./runtime/types.ts";
import type { Lane, QueuedMessage, SubmissionAttempt } from "./store-types.ts";
import { reserveSubmission, saveSubmissionJournal, submissionJournal } from "./submission-journal.ts";

export function identifiedInbox(d: Deps, ref: SessionRef): QueuedMessage[] {
  const messages = d.store.queued(ref);
  if ((ref.runtime === "codex" || d.store.laneBySession(ref)) && messages.some((message) => !message.deliveryId))
    return d.store.updateInbox(ref, (current) =>
      current.map((message) => ({ ...message, deliveryId: message.deliveryId ?? crypto.randomUUID() })),
    );
  return messages;
}

export function batchIdentity(messages: readonly QueuedMessage[]): string {
  const submission = messages[0]?.submission;
  if (submission) return submission.id;
  const ids = messages.map((message) => message.deliveryId ?? [message.at, message.from, message.text]);
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(ids)).digest("hex");
}

/** A reserved batch is retried alone: messages appended later belong to another submission. */
export function prepareMessages(
  d: Deps,
  ref: SessionRef,
  messages: readonly QueuedMessage[],
): readonly QueuedMessage[] {
  const lane = d.store.laneBySession(ref);
  if (!lane && ref.runtime !== "codex") return messages;
  const reserved = messages.find((message) => message.submission)?.submission;
  if (reserved) return messages.filter((message) => message.submission?.id === reserved.id);
  const submission = reserveSubmission(d, ref);
  const ids = new Set(messages.map((message) => message.deliveryId));
  return d.store
    .updateInbox(ref, (current) =>
      current.map((message) => (ids.has(message.deliveryId) ? { ...message, submission } : message)),
    )
    .filter((message) => message.submission?.id === submission.id);
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
  if (!lane || lane.status === "lost") return;
  const state = submissionJournal(d, ref);
  const submission =
    d.store.queued(ref).find((message) => message.submission?.id === admissionId)?.submission ??
    (state.admitted?.id === admissionId ? state.admitted : undefined) ??
    (state.reserved?.id === admissionId ? state.reserved : reserveSubmission(d, ref, admissionId));
  recordAdmission(d, lane, submission);
}

function recordAdmission(d: Deps, lane: Lane, submission: SubmissionAttempt): void {
  const state = submissionJournal(d, lane.sessionRef);
  const newest = state.admitted && state.admitted.order >= submission.order ? state.admitted : submission;
  if (lane.admissionId !== newest.id || lane.admissionOrder !== newest.order) {
    if (lane.admissionId !== newest.id) {
      if (lane.status === "ready") lane.status = "working";
      delete lane.final;
    }
    lane.admissionId = newest.id;
    lane.admissionOrder = newest.order;
    d.store.saveLane(lane);
  }
  // Persist after the lane write: a failed invalidation must remain recoverable.
  if (!state.admitted || newest.order > state.admitted.order)
    saveSubmissionJournal(d, lane.sessionRef, { ...state, admitted: newest });
}

export function reconcileAdmission(d: Deps, ref: SessionRef): void {
  const lane = d.store.laneBySession(ref);
  const admitted = submissionJournal(d, ref).admitted;
  if (lane && lane.status !== "lost" && admitted) recordAdmission(d, lane, admitted);
}

/** Operator acknowledgement and fresh READY reconcile the same held batch under its inbox lock. */
export function admitHeld(d: Deps, ref: SessionRef, message: QueuedMessage): void {
  const lane = d.store.laneBySession(ref);
  if (!lane || lane.status === "lost") return;
  if (!message.deliveryId) throw new TypeError("Held lane message is missing its stable identity");
  const held = d.store.queued(ref).find((entry) => entry.deliveryId === message.deliveryId);
  if (held?.attempt?.state !== "ambiguous") return;
  if (held.submission) {
    recordAdmission(d, lane, held.submission);
    return;
  }
  if (held.attempt.admission?.recorded) return;
  // Existing held entries predate ordered reservations; do not invent their original native attempt.
  const admissionId = held.attempt.admission?.id ?? batchIdentity([held]);
  const submission = { id: admissionId, order: 0 };
  recordAdmission(d, lane, submission);
  d.store.updateInbox(ref, (current) =>
    current.map((entry) => {
      const sameBatch = held.attempt?.admission
        ? entry.attempt?.admission?.id === admissionId
        : entry.deliveryId === held.deliveryId;
      return sameBatch && entry.attempt?.state === "ambiguous" ? { ...entry, submission } : entry;
    }),
  );
}
