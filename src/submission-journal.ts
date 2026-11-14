import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Deps } from "./harness.ts";
import type { SessionRef } from "./runtime/types.ts";
import { object, text } from "./runtime/codex/protocol.ts";
import type { SubmissionAttempt } from "./store-types.ts";

type SubmissionJournal = {
  readonly reserved?: SubmissionAttempt;
  readonly admitted?: SubmissionAttempt;
};

function attempt(value: unknown): SubmissionAttempt | undefined {
  if (value === undefined) return undefined;
  const raw = object(value);
  const order = raw["order"];
  if (typeof order !== "number" || !Number.isSafeInteger(order) || order < 0)
    throw new TypeError("Invalid durable submission order");
  return { id: text(raw["id"]), order };
}

/** The inbox lock serializes these records; ordinary lane saves cannot overwrite them. */
export function submissionJournal(d: Deps, ref: SessionRef): SubmissionJournal {
  const path = `${d.store.inboxPath(ref)}.admission`;
  if (!existsSync(path)) return {};
  const raw = object(JSON.parse(readFileSync(path, "utf8")));
  const reserved = attempt(raw["reserved"]);
  const admitted = attempt(raw["admitted"]);
  return { ...(reserved ? { reserved } : {}), ...(admitted ? { admitted } : {}) };
}

export function saveSubmissionJournal(d: Deps, ref: SessionRef, value: SubmissionJournal): void {
  const path = `${d.store.inboxPath(ref)}.admission`;
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function reserveSubmission(d: Deps, ref: SessionRef, id: string = crypto.randomUUID()): SubmissionAttempt {
  const state = submissionJournal(d, ref);
  const reserved = { id, order: Math.max(state.reserved?.order ?? 0, state.admitted?.order ?? 0) + 1 };
  saveSubmissionJournal(d, ref, { ...state, reserved });
  return reserved;
}
