import { takeInboxLock } from "../../inbox-lock.ts";
import type { CreateSpec } from "../types.ts";
import { array, type CodexConnection, CodexError, object, text } from "./protocol.ts";
import type { CodexStore, RecordEntry } from "./store.ts";
import { assertAdmittedMcpServers, disabledConfiguredMcpServers } from "./bridge-install.ts";
import { readThread, startParams, type Environment } from "./threads.ts";

type ReviewResult = { readonly stdout: string; readonly code: number; readonly stderr: string };

/**
 * Closes a thread whose MCP admission was refused. thread/archive is the strongest documented close: it shuts the
 * thread down even while another client is subscribed, but still returns success if that shutdown times out, so MCP
 * teardown is not confirmed. The refusal is always the thrown error; archive and persistence failures are attached as
 * its cause. The record closes only after the archive succeeds, otherwise it stays uncertain for later recovery.
 */
export const refuseAdmittedThread = async (
  connection: CodexConnection,
  store: CodexStore,
  entry: RecordEntry,
  refusal: unknown,
): Promise<never> => {
  const primary = refusal instanceof Error ? refusal : new CodexError("unsupported", String(refusal));
  const failures: unknown[] = [];
  let archived = false;
  try {
    await connection.call("thread/archive", { threadId: entry.id });
    archived = true;
  } catch (cleanup) {
    failures.push(cleanup);
  }
  try {
    await store.save(
      archived
        ? { ...entry, closed: true }
        : { ...entry, uncertain: "MCP admission was refused but archiving the thread failed" },
    );
  } catch (persistence) {
    failures.push(persistence);
  }
  if (failures.length)
    Object.assign(primary, {
      cause: failures.length === 1 ? failures[0] : new AggregateError(failures, "Refused thread cleanup failed"),
    });
  throw primary;
};

const admissionLock = (store: CodexStore, id: string) =>
  takeInboxLock(`${store.path(id)}.submit-lock`, Date.now(), { reservationAuthoritative: true });

/**
 * Admits a fresh thread while holding its submit lock for the whole window: the pending record is saved, the MCP
 * check runs (bounded by `milliseconds`), and admission commits only if the record is still pending and open. Any
 * refusal, including a refused commit, archives the thread with the refusal kept primary. A pending record whose lock
 * can be taken therefore belongs to an admitter that is gone. The lock trusts its SQLite reservation, so leftover
 * metadata naming a reused process ID cannot make a dead admitter look alive.
 */
export const admitThread = async (
  connection: CodexConnection,
  store: CodexStore,
  pending: RecordEntry,
  allowed: ReadonlySet<string>,
  milliseconds: number,
): Promise<RecordEntry> => {
  let release: (() => void) | undefined;
  try {
    await store.init();
    release = admissionLock(store, pending.id);
    if (!release) throw new CodexError("uncertain", "Admission could not reserve the new thread");
    await store.save(pending);
    await assertAdmittedMcpServers(connection, pending.spec.cwd, pending.id, allowed, milliseconds);
    const current = await store.owned({ runtime: "codex", id: pending.id }, true);
    if (current.closed || current.admission !== "pending")
      throw new CodexError("ownership", "Thread record changed before admission was committed");
    const { admission: _admission, ...admitted } = current;
    await store.save(admitted);
    return admitted;
  } catch (refusal) {
    const current = await store.owned({ runtime: "codex", id: pending.id }, true).catch(() => pending);
    return await refuseAdmittedThread(connection, store, current, refusal);
  } finally {
    release?.();
  }
};

/**
 * Archives a pending record whose admitter is gone, never resuming or delivering into it. A record whose admission
 * lock is still held belongs to a live admitter and is skipped (`attempted` false). Any cleanup failure is returned
 * for the caller to report.
 */
export const archiveAbandonedAdmission = async (
  connection: CodexConnection,
  store: CodexStore,
  id: string,
): Promise<{ readonly attempted: boolean; readonly failure?: unknown }> => {
  const release = admissionLock(store, id);
  if (!release) return { attempted: false };
  try {
    const current = await store.owned({ runtime: "codex", id }, true);
    if (current.closed || current.admission !== "pending") return { attempted: false };
    const abandoned = new CodexError("uncertain", "MCP admission was abandoned before it completed");
    const failure = await refuseAdmittedThread(connection, store, current, abandoned).catch((error: unknown) =>
      error instanceof Error && error.cause !== undefined ? error : undefined,
    );
    return { attempted: true, ...(failure === undefined ? {} : { failure }) };
  } finally {
    release();
  }
};

/** A review owns a fresh read-only thread and only interrupts the turn it started. */
export const runReview = async (
  store: CodexStore,
  connection: CodexConnection,
  env: Environment,
  prompt: string,
  model?: string,
  signal?: AbortSignal,
): Promise<ReviewResult> => {
  if (signal?.aborted) return { stdout: "", code: 1, stderr: "Codex review cancelled" };
  const milliseconds = Number(env["DORI_CODEX_REVIEW_TIMEOUT_MS"] || 120_000);
  if (!Number.isFinite(milliseconds) || milliseconds < 1)
    throw new CodexError("unsupported", "DORI_CODEX_REVIEW_TIMEOUT_MS must be positive");
  const spec: CreateSpec = {
    name: "review",
    role: "lane",
    cwd: env["DORI_CODEX_WORKSPACE"] || process.cwd(),
    env: {},
    container: "tab",
  };
  const params = startParams(store.root, spec, env);
  const disabled = await disabledConfiguredMcpServers(connection, spec.cwd);
  const response = object(
    await connection.call("thread/start", {
      ...params,
      sandbox: "read-only",
      config: { ...object(params["config"]), mcp_servers: disabled },
      ...(model ? { model } : {}),
    }),
  );
  const id = text(object(response["thread"])["id"]);
  const pending: RecordEntry = { id, spec, closed: false, admission: "pending" };
  const entry = await admitThread(connection, store, pending, new Set(Object.keys(disabled)), milliseconds);
  const completed = Promise.withResolvers<Record<string, unknown>>();
  let turnId: string | undefined;
  let finished = false;
  let closeable = false;
  const messageId = crypto.randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const listener = (event: { readonly method: string; readonly params: Record<string, unknown> }) => {
    if (event.method !== "turn/completed" || event.params["threadId"] !== id) return;
    const turn = object(event.params["turn"]);
    if (!turnId || turn["id"] === turnId) {
      finished = true;
      completed.resolve(turn);
    }
  };
  connection.listeners.add(listener);
  try {
    await store.save({ ...entry, uncertain: "Native review submission may have been accepted" });
    const started = object(
      await connection.call("turn/start", {
        threadId: id,
        clientUserMessageId: messageId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      }),
    );
    turnId = text(object(started["turn"])["id"]);
    await store.save(entry);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CodexError("unsupported", "Codex review timed out")), milliseconds);
      cancel = () => reject(new CodexError("unsupported", "Codex review cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
    const turn = await Promise.race([completed.promise, timeout]);
    closeable = true;
    return {
      stdout: await readThread(connection, id, Number.MAX_SAFE_INTEGER, true),
      code: turn["status"] === "completed" ? 0 : 1,
      stderr: turn["error"] ? JSON.stringify(turn["error"]) : "",
    };
  } catch (error) {
    if (!(error instanceof CodexError && error.kind === "remote")) {
      await connection.call("thread/resume", { threadId: id, excludeTurns: true });
      const page = object(
        await connection.call("thread/turns/list", {
          threadId: id,
          sortDirection: "desc",
          limit: 1,
          itemsView: "full",
        }),
      );
      for (const value of array(page["data"])) {
        const turn = object(value);
        if (
          turnId ? turn["id"] === turnId : array(turn["items"]).some((item) => object(item)["clientId"] === messageId)
        ) {
          turnId = text(turn["id"]);
          finished = finished || turn["status"] !== "inProgress";
        }
      }
      if (!turnId)
        throw new CodexError("uncertain", "Review admission could not be resolved; owned thread remains recoverable");
    }
    if (turnId && !finished) {
      await connection.call("turn/interrupt", { threadId: id, turnId });
      await Promise.race([
        completed.promise,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new CodexError("uncertain", "Review cancellation was not confirmed")),
            5_000,
          );
        }),
      ]);
    }
    closeable = true;
    return { stdout: "", code: 1, stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
    clearTimeout(deadline);
    if (cancel) signal?.removeEventListener("abort", cancel);
    connection.listeners.delete(listener);
    if (closeable) {
      await connection.call("thread/unsubscribe", { threadId: id });
      await store.save({ ...entry, closed: true });
    } else await store.save({ ...entry, uncertain: "Review cleanup is uncertain; inspect owned thread history" });
  }
};
