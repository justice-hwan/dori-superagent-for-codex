import type { SessionRef } from "../types.ts";
import { CodexError, object, type CodexConnection } from "./protocol.ts";
import { assertEndpoint, type CodexStore } from "./store.ts";
import { takeManagedSubmit } from "./submit-lock.ts";
import { closeWorker } from "./workers.ts";

/** Prepared effects fail closed on optional raw fields the legacy ownership reader can omit. */
export async function preparedOwned(store: CodexStore, ref: SessionRef, allowClosed = false) {
  const raw = object(await Bun.file(store.path(ref.id)).json());
  if (
    raw["admission"] !== undefined ||
    raw["uncertain"] !== undefined ||
    (raw["desktopOwned"] !== undefined && raw["desktopOwned"] !== false)
  )
    throw new CodexError("ownership", "Prepared ownership is held or malformed");
  if (raw["confirmed"] !== undefined) {
    const batch = object(raw["confirmed"]);
    if (
      typeof batch["id"] !== "string" ||
      !batch["id"] ||
      !Array.isArray(batch["messageIds"]) ||
      !batch["messageIds"].length ||
      batch["messageIds"].some((value) => typeof value !== "string" || !value)
    )
      throw new CodexError("ownership", "Prepared confirmation is malformed");
  }
  return store.owned(ref, allowClosed);
}

/** Caller owns this exact session's submission reservation. */
export async function closeOwned(store: CodexStore, connection: CodexConnection, ref: SessionRef): Promise<void> {
  const entry = await store.owned(ref, true);
  if (entry.closed) return;
  assertEndpoint(entry, connection.address);
  if (entry.desktopOwned) throw new CodexError("ownership", "Take back desktop ownership before closing");
  if (ref.id.startsWith("worker-")) await closeWorker(entry);
  else await connection.call(entry.admission ? "thread/archive" : "thread/unsubscribe", { threadId: ref.id });
  await store.save({ ...entry, closed: true });
}

/** Retains the reservation; preparation never probes or changes native thread state. */
export async function prepareClose(store: CodexStore, connection: CodexConnection, ref: SessionRef) {
  const bound = { runtime: ref.runtime, id: ref.id };
  const release = takeManagedSubmit(store, bound.id);
  if (!release) return undefined;
  try {
    const snapshot = await preparedOwned(store, bound, true);
    assertEndpoint(snapshot, connection.address);
    const identity = JSON.stringify([snapshot.spec, snapshot.envelope]);
    let disposed = false;
    let used = false;
    return {
      async execute(): Promise<void> {
        if (used || disposed) throw new CodexError("ownership", "Prepared close already used or disposed");
        used = true;
        const current = await preparedOwned(store, bound, true);
        if (JSON.stringify([current.spec, current.envelope]) !== identity)
          throw new CodexError("ownership", "Prepared close ownership changed");
        await closeOwned(store, connection, bound);
      },
      [Symbol.dispose](): void {
        if (disposed) return;
        disposed = true;
        release();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
