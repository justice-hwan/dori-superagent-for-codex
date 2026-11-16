import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { takeInboxLock } from "../../inbox-lock.ts";
import { takeManagedSubmit } from "./submit-lock.ts";
import { inboxFile } from "../../inbox-files.ts";
import type { DeliverOptions, DeliverOutcome, SessionRef } from "../types.ts";
import { type CodexConnection, CodexError, object, text } from "./protocol.ts";
import { assertEndpoint, type CodexStore } from "./store.ts";
import { instructions, probeThread, type Environment } from "./threads.ts";
import { messageInstructions } from "./message-instructions.ts";
import { MessageJournal } from "./message-journal.ts";
import { unseenTurns, type MessageSource } from "./message-schema.ts";

export const deliver = async (
  store: CodexStore,
  connection: CodexConnection,
  ref: SessionRef,
  prompt: string,
  opts?: DeliverOptions,
  systemPrompt?: string,
  env: Environment = process.env,
  receipt?: { readonly source: MessageSource; readonly action: string },
): Promise<DeliverOutcome> => {
  await store.owned(ref);
  if (ref.id.startsWith("worker-")) return { kind: "no-agent" };
  // Batch delivery is called by flushInbox while its caller owns the inbox reservation.
  let inbox: (() => void) | undefined;
  if (!opts?.batch) {
    const path = inboxFile(store.root, ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    inbox = takeInboxLock(`${path}.lock`, Date.now(), { metadataAfterReservation: true });
    if (!inbox) return { kind: "not-ready", status: "working" };
  }
  let release: (() => void) | undefined;
  try {
    release = takeManagedSubmit(store, ref.id);
    if (!release) return { kind: "not-ready", status: "working" };
    const entry = await store.owned(ref);
    assertEndpoint(entry, connection.address);
    if (entry.confirmed)
      return entry.confirmed.id === opts?.batch?.id
        ? { kind: "delivered", started: true }
        : { kind: "not-ready", status: "blocked" };
    inbox?.();
    inbox = undefined;
    if (entry.desktopOwned) return { kind: "not-ready", status: "blocked" };
    if (entry.uncertain)
      return { kind: "ambiguous", detail: entry.uncertain, failure: new CodexError("uncertain", entry.uncertain) };
    using journal = new MessageJournal(store, ref.id);
    if (receipt && opts?.batch) throw new CodexError("ownership", "Receipt cannot admit an inbox batch");
    if (!journal.admit(ref.id, prompt, receipt)) return { kind: "not-ready", status: "working" };
    const probe = await probeThread(connection, ref.id);
    if (probe.status !== "idle" || opts?.when === "working") return { kind: "not-ready", status: probe.status };
    if (systemPrompt || !connection.isSubscribed(ref.id)) {
      const role = systemPrompt
        ? entry.envelope
          ? await messageInstructions(store.root, entry.spec, ref.id)
          : instructions(store.root, entry.spec, env)
        : undefined;
      await connection.call("thread/resume", {
        threadId: ref.id,
        excludeTurns: true,
        ...(systemPrompt
          ? { developerInstructions: entry.envelope ? `${systemPrompt}\n\n${role}` : `${role}\n\n${systemPrompt}` }
          : {}),
      });
      if ((await probeThread(connection, ref.id)).status !== "idle") return { kind: "not-ready", status: "working" };
    }
    const input = [{ type: "text", text: prompt, text_elements: [] }],
      client = crypto.randomUUID();
    journal.intend(
      client,
      createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      opts?.batch,
      receipt?.source,
    );
    const uncertain = `Submission ${client} may have been accepted; inspect canonical history before retrying`;
    await store.save({ ...entry, uncertain });
    let accepted: { readonly turn: string; readonly at: number } | undefined;
    try {
      const started = object(
        await connection.call("turn/start", { threadId: ref.id, clientUserMessageId: client, input }),
      );
      accepted = { turn: text(object(started["turn"])["id"]), at: Date.now() };
      journal.accept(client, accepted.turn, accepted.at);
      await store.save({ ...entry, ...(opts?.batch ? { confirmed: opts.batch } : {}) });
      return { kind: "delivered", started: true };
    } catch (error) {
      const rejected = error instanceof CodexError && error.kind === "remote";
      let failure = error;
      try {
        journal.fail(client, error, !rejected, accepted);
      } catch (persistence) {
        failure = new AggregateError([error, persistence], "Submission and evidence failed");
      }
      if (rejected && failure === error) {
        await store.save(entry);
        throw error;
      }
      return { kind: "ambiguous", detail: uncertain, failure };
    }
  } finally {
    release?.();
    inbox?.();
  }
};

/** Explicit takeback is the only path that can release desktop ownership and rejoin its runtime. */
export const handoff = async (
  store: CodexStore,
  connection: CodexConnection,
  ref: SessionRef,
  toDesktop: boolean,
): Promise<void> => {
  await store.owned(ref);
  if (ref.id.startsWith("worker-")) throw new CodexError("unsupported", "Loop workers cannot be handed to desktop");
  const release = takeManagedSubmit(store, ref.id);
  if (!release) throw new CodexError("unsupported", "A submission is still in progress");
  try {
    const entry = await store.owned(ref);
    assertEndpoint(entry, connection.address);
    if (toDesktop) {
      await store.save({ ...entry, desktopOwned: true });
      return;
    }
    if ((await probeThread(connection, ref.id, false)).status !== "idle")
      throw new CodexError("unsupported", "Desktop thread must be idle before takeback");
    if (entry.envelope) {
      using journal = new MessageJournal(store, ref.id);
      for (const turn of await unseenTurns(connection, ref.id, (turn) => journal.seen(text(turn["id"]))))
        journal.observe(text(turn["id"]), "desktop-owned");
    }
    if ((await probeThread(connection, ref.id, false)).status !== "idle")
      throw new CodexError("unsupported", "Desktop thread changed before takeback");
    await store.save({ ...entry, desktopOwned: false });
    try {
      const resumed = object(
        object(await connection.call("thread/resume", { threadId: ref.id, excludeTurns: true }))["thread"],
      );
      if (
        realpathSync(text(resumed["cwd"])) !== realpathSync(entry.spec.cwd) ||
        object(resumed["status"])["type"] !== "idle"
      )
        throw new CodexError("ownership", "Takeback rejoin state changed");
    } catch (error) {
      await store.save({ ...entry, desktopOwned: true });
      throw error;
    }
  } finally {
    release();
  }
};
