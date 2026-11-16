import { realpathSync } from "node:fs";
import type { Deps } from "../../harness.ts";
import { doneWithOwnedInbox } from "../../lanes.ts";
import { Refusal } from "../../refusal.ts";
import { KEY_RE } from "../../store-types.ts";
import { submissionJournal } from "../../submission-journal.ts";
import type { BridgeScope } from "./bridge-tools.ts";
import { prepareClose, preparedOwned } from "./close.ts";
import type { DoneTarget } from "./done-target.ts";
import { CodexError, object, text, type CodexConnection, type Notification } from "./protocol.ts";
import type { MessageJournal } from "./message-journal.ts";
import type { ManagementFinal } from "./message-schema.ts";
import { assertEndpoint, type CodexStore } from "./store.ts";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bind identity before resource admission; historical key-only actions cannot invent a target. */
export async function prepareBoundDone(input: {
  d: Deps;
  scope: BridgeScope;
  store: CodexStore;
  connection: CodexConnection;
  journal: MessageJournal;
  final: ManagementFinal;
  event: Notification | undefined;
  historical: ReadonlySet<string> | undefined;
}) {
  const { d, scope, store, connection, journal, final, event, historical } = input;
  await preparedOwned(store, { runtime: "codex", id: scope.id });
  let binding = journal.doneTarget(final, scope.cwd);
  if (!binding) {
    const fresh = historical
      ? !historical.has(final.source.turnId)
      : event?.method === "turn/completed" &&
        event.params["threadId"] === scope.id &&
        object(event.params["turn"])["id"] === final.source.turnId;
    if (!fresh) throw new CodexError("uncertain", "Unbound historical done action requires handoff");
    binding = journal.bindDoneTarget(
      final,
      scope.cwd,
      readDoneTarget(d, text(final.action.arguments["key"]), scope.cwd),
    );
  }
  return { binding, prepared: await prepareBridgeDone({ d, scope, target: binding.target, store, connection }) };
}

/** Resolve once before deferral; subsequent admission compares this concrete generation. */
export function readDoneTarget(d: Deps, key: string, cwd: string): DoneTarget {
  if (!KEY_RE.test(key)) throw new Refusal("Invalid lane key");
  const lane = d.store.lane(key);
  if (
    !lane ||
    lane.key !== key ||
    lane.sessionRef.runtime !== "codex" ||
    !ID.test(lane.sessionRef.id) ||
    realpathSync(lane.cwd) !== cwd ||
    lane.migration
  )
    throw new Refusal("Lane is outside this workspace or changed");
  if (
    lane.status !== "ready" ||
    !lane.final ||
    typeof lane.final.text !== "string" ||
    !lane.final.text.trim() ||
    !Array.isArray(lane.final.evidence) ||
    lane.final.evidence.length === 0 ||
    lane.final.evidence.some((value) => typeof value !== "string") ||
    !Number.isFinite(lane.final.at) ||
    !Number.isSafeInteger(lane.createdAt) ||
    lane.createdAt < 0 ||
    (lane.admissionId !== undefined && (typeof lane.admissionId !== "string" || !lane.admissionId)) ||
    (lane.admissionOrder !== undefined && (!Number.isSafeInteger(lane.admissionOrder) || lane.admissionOrder < 0)) ||
    (lane.admissionId === undefined) !== (lane.admissionOrder === undefined)
  )
    throw new Refusal("Lane READY or admission generation is invalid");
  return {
    runtime: "codex",
    id: lane.sessionRef.id,
    cwd,
    key,
    createdAt: lane.createdAt,
    admissionId: lane.admissionId ?? null,
    admissionOrder: lane.admissionOrder ?? null,
    readyHash: new Bun.CryptoHasher("sha256").update(JSON.stringify(lane.final)).digest("hex"),
  };
}

export async function prepareBridgeDone({
  d,
  scope,
  target,
  store,
  connection,
}: {
  d: Deps;
  scope: BridgeScope;
  target: DoneTarget;
  store: CodexStore;
  connection: CodexConnection;
}): Promise<
  | { kind: "deferred"; resource: "inbox" | "submit"; id: string }
  | { kind: "prepared"; execute(): Promise<unknown>; [Symbol.dispose](): void }
> {
  // Copy the durable binding: a caller cannot retarget a held capability by mutating its input.
  const bound = { ...target };
  if (
    bound.runtime !== "codex" ||
    typeof bound.id !== "string" ||
    !ID.test(bound.id) ||
    typeof bound.cwd !== "string" ||
    typeof bound.key !== "string" ||
    !KEY_RE.test(bound.key) ||
    !Number.isSafeInteger(bound.createdAt) ||
    bound.createdAt < 0 ||
    (bound.admissionId !== null && (typeof bound.admissionId !== "string" || !bound.admissionId)) ||
    (bound.admissionOrder !== null && (!Number.isSafeInteger(bound.admissionOrder) || bound.admissionOrder < 0)) ||
    (bound.admissionId === null) !== (bound.admissionOrder === null) ||
    typeof bound.readyHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(bound.readyHash)
  )
    throw new Refusal("Invalid done target binding");
  const source = { ...scope };
  if (
    realpathSync(d.store.root) !== source.root ||
    realpathSync(store.root) !== source.root ||
    source.role !== "lead" ||
    source.id === bound.id ||
    source.cwd !== bound.cwd
  )
    throw new Refusal("Bridge done scope mismatch");
  const ref = { runtime: "codex" as const, id: bound.id };
  store.path(ref.id);
  const inbox = d.store.lockInbox(ref, d.now());
  if (!inbox) return { kind: "deferred", resource: "inbox", id: bound.id };
  let close: Awaited<ReturnType<typeof prepareClose>>;
  try {
    close = await prepareClose(store, connection, ref);
    if (!close) {
      inbox();
      return { kind: "deferred", resource: "submit", id: bound.id };
    }
    const validate = async (allowClosed = false) => {
      if (
        realpathSync(d.store.root) !== source.root ||
        realpathSync(store.root) !== source.root ||
        source.role !== "lead" ||
        source.id === bound.id ||
        source.cwd !== bound.cwd
      )
        throw new Refusal("Bridge done scope mismatch");
      const lead = d.store.roles().lead;
      if (lead?.runtime !== "codex" || lead.id !== source.id)
        throw new Refusal("Bridge capability is no longer registered");
      const owned = await preparedOwned(store, { runtime: "codex", id: source.id });
      assertEndpoint(owned, connection.address);
      if (
        owned.spec.role !== "lead" ||
        realpathSync(owned.spec.cwd) !== source.cwd ||
        !owned.envelope ||
        owned.desktopOwned ||
        owned.uncertain !== undefined ||
        owned.confirmed
      )
        throw new Refusal("Bridge source authority is held or changed");
      const entry = await preparedOwned(store, ref, allowClosed);
      assertEndpoint(entry, connection.address);
      if (
        entry.spec.role !== "lane" ||
        entry.spec.env["DORI_LANE"] !== bound.key ||
        realpathSync(entry.spec.cwd) !== bound.cwd ||
        !entry.envelope ||
        entry.desktopOwned ||
        entry.uncertain !== undefined ||
        entry.admission === "pending" ||
        (entry.confirmed !== undefined && entry.confirmed.id !== bound.admissionId)
      )
        throw new Refusal("Bound done target authority is held or changed");
      const current = readDoneTarget(d, bound.key, bound.cwd);
      if (
        current.runtime !== bound.runtime ||
        current.id !== bound.id ||
        current.cwd !== bound.cwd ||
        current.key !== bound.key ||
        current.createdAt !== bound.createdAt ||
        current.admissionId !== bound.admissionId ||
        current.admissionOrder !== bound.admissionOrder ||
        current.readyHash !== bound.readyHash
      )
        throw new Refusal("Bound done target generation changed");
      const admitted = submissionJournal(d, ref).admitted;
      if (admitted && (admitted.id !== bound.admissionId || admitted.order !== bound.admissionOrder))
        throw new Refusal("Bound done target admission changed");
    };
    await validate();
    const lifecycle = close;
    let disposed = false;
    let used = false;
    return {
      kind: "prepared",
      async execute() {
        if (used || disposed) throw new Refusal("Prepared done already used or disposed");
        used = true;
        await doneWithOwnedInbox(d, bound.key, ref, () => lifecycle.execute(), validate);
        return { closed: true };
      },
      [Symbol.dispose]() {
        if (disposed) return;
        disposed = true;
        try {
          lifecycle[Symbol.dispose]();
        } finally {
          inbox();
        }
      },
    };
  } catch (error) {
    try {
      close?.[Symbol.dispose]();
    } finally {
      inbox();
    }
    throw error;
  }
}
