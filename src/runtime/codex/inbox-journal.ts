import { takeInboxLock } from "../../inbox-lock.ts";
import type { DeliveryBatch, SessionRef } from "../types.ts";
import { CodexError } from "./protocol.ts";
import type { CodexStore } from "./store.ts";

export const confirmedDelivery = async (store: CodexStore, ref: SessionRef): Promise<DeliveryBatch | undefined> =>
  (await store.owned(ref)).confirmed;

export const acknowledgeDelivery = async (store: CodexStore, ref: SessionRef, batchId: string): Promise<void> => {
  await store.owned(ref);
  const release = takeInboxLock(`${store.path(ref.id)}.submit-lock`, Date.now());
  if (!release) throw new CodexError("unsupported", "A submission is still in progress");
  try {
    const entry = await store.owned(ref);
    if (entry.confirmed?.id !== batchId) return;
    const { confirmed: _confirmed, ...settled } = entry;
    await store.save(settled);
  } finally {
    release();
  }
};
