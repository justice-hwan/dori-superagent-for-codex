import { takeInboxLock } from "../../inbox-lock.ts";
import type { DeliverOptions, DeliverOutcome, SessionRef } from "../types.ts";
import { type CodexConnection, CodexError } from "./protocol.ts";
import type { CodexStore } from "./store.ts";
import { instructions, probeThread, type Environment } from "./threads.ts";

export const deliver = async (
  store: CodexStore,
  connection: CodexConnection,
  ref: SessionRef,
  prompt: string,
  opts?: DeliverOptions,
  systemPrompt?: string,
  env: Environment = process.env,
): Promise<DeliverOutcome> => {
  await store.owned(ref);
  if (ref.id.startsWith("worker-")) return { kind: "no-agent" };
  const release = takeInboxLock(`${store.path(ref.id)}.submit-lock`, Date.now());
  if (!release) return { kind: "not-ready", status: "working" };
  try {
    const entry = await store.owned(ref);
    if (entry.confirmed) {
      return entry.confirmed.id === opts?.batch?.id
        ? { kind: "delivered", started: true }
        : { kind: "not-ready", status: "blocked" };
    }
    if (entry.desktopOwned) return { kind: "not-ready", status: "blocked" };
    if (entry.uncertain)
      return { kind: "ambiguous", detail: entry.uncertain, failure: new CodexError("uncertain", entry.uncertain) };
    const probe = await probeThread(connection, ref.id);
    if (probe.status !== "idle" || opts?.when === "working") return { kind: "not-ready", status: probe.status };
    if (systemPrompt)
      await connection.call("thread/resume", {
        threadId: ref.id,
        excludeTurns: true,
        developerInstructions: `${instructions(store.root, entry.spec, env)}\n\n${systemPrompt}`,
      });
    const uncertain = `Submission ${crypto.randomUUID()} may have been accepted; inspect desktop history before retrying`;
    await store.save({ ...entry, uncertain });
    try {
      await connection.call("turn/start", {
        threadId: ref.id,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      });
      await store.save({ ...entry, ...(opts?.batch ? { confirmed: opts.batch } : {}) });
      return { kind: "delivered", started: true };
    } catch (error) {
      if (error instanceof CodexError && error.kind === "remote") {
        await store.save(entry);
        throw error;
      }
      return { kind: "ambiguous", detail: uncertain, failure: error };
    }
  } finally {
    release();
  }
};

export const handoff = async (
  store: CodexStore,
  connection: CodexConnection,
  ref: SessionRef,
  toDesktop: boolean,
): Promise<void> => {
  await store.owned(ref);
  if (ref.id.startsWith("worker-")) throw new CodexError("unsupported", "Loop workers cannot be handed to desktop");
  const release = takeInboxLock(`${store.path(ref.id)}.submit-lock`, Date.now());
  if (!release) throw new CodexError("unsupported", "A submission is still in progress");
  try {
    const entry = await store.owned(ref);
    if (!toDesktop && (await probeThread(connection, ref.id)).status !== "idle")
      throw new CodexError("unsupported", "Desktop thread must be idle before takeback");
    await store.save({ ...entry, desktopOwned: toDesktop });
  } finally {
    release();
  }
};
