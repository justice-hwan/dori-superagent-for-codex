import { homedir } from "node:os";
import { join } from "node:path";
import { takeInboxLock } from "../../inbox-lock.ts";
import type {
  AgentIdentity,
  AgentLaunch,
  CloseScope,
  CreateSpec,
  DeliverOptions,
  DeliverOutcome,
  Key,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { NativeStartUncertain } from "../types.ts";
import { prepareBridge } from "./bridge-install.ts";
import { CodexConnection, CodexError, object, text } from "./protocol.ts";
import { deliver, handoff } from "./delivery.ts";
import { runReview } from "./review.ts";
import { CodexStore, reference } from "./store.ts";
import { defaultCommand, probeThread, readThread, startParams, type Environment } from "./threads.ts";
import { watchIdle } from "./watch.ts";
import { closeWorker, probeWorker, readWorker, startWorker } from "./workers.ts";

/** Shared-daemon client. Closing Dori sessions never stops the desktop daemon. */
export class CodexRuntime implements SessionRuntime {
  readonly kind = "codex";
  private readonly store: CodexStore;
  private readonly connection: CodexConnection;
  private readonly env: Environment;

  constructor(root: string, env?: Environment) {
    const inherited = env ?? process.env;
    this.env = { ...inherited, DORI_CMD: inherited["DORI_CMD"] || defaultCommand };
    this.store = new CodexStore(root);
    const socket =
      inherited["DORI_CODEX_SOCKET"] ||
      join(inherited["HOME"] || homedir(), ".codex/app-server-control/app-server-control.sock");
    this.connection = new CodexConnection(socket.startsWith("/") ? `ws+unix://${socket}:/` : socket);
  }

  self(): SessionRef | undefined {
    const id = this.env["DORI_CODEX_WORKER"] || this.env["CODEX_THREAD_ID"];
    if (!id) return undefined;
    // Synchronous self-discovery is only a hint. Every operation checks ownership.
    return { runtime: "codex", id };
  }

  async createGroup(label: string, _cwd: string): Promise<string> {
    return label;
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    const worker = spec.role === "duty-loop" || spec.role === "hourly-loop";
    const bridge =
      !worker && this.env["DORI_CODEX_BRIDGE"] === "stdio" ? prepareBridge(this.store.root, spec, this.env) : undefined;
    const params = startParams(this.store.root, spec, this.env);
    let response: Record<string, unknown> | undefined;
    try {
      response = worker
        ? undefined
        : object(
            await this.connection.call("thread/start", {
              ...params,
              config: { ...object(params["config"]), ...bridge?.config },
            }),
          );
    } catch (error) {
      bridge?.discard();
      throw error;
    }
    const id = response ? text(object(response["thread"])["id"]) : `worker-${crypto.randomUUID()}`;
    const entry = { id, spec, closed: false };
    await this.store.save(entry);
    bridge?.bind(id);
    if (!worker)
      await this.connection.call("thread/name/set", { threadId: id, name: `Dori ${spec.role}: ${spec.name}` });
    return reference(entry);
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    const entry = await this.store.owned(ref);
    if (!ref.id.startsWith("worker-"))
      throw new CodexError("unsupported", "Agent prompts require startAgent, never a shell command");
    await startWorker(this.store, entry, command, this.env);
  }

  async startAgent(ref: SessionRef, launch: AgentLaunch): Promise<void> {
    const result = await deliver(
      this.store,
      this.connection,
      ref,
      launch.prompt,
      undefined,
      launch.systemPrompt,
      this.env,
    );
    if (result.kind === "ambiguous") throw new NativeStartUncertain(ref, result.detail);
    if (result.kind !== "delivered") throw new CodexError("unsupported", `Codex start: ${result.kind}`);
  }

  async list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    const entries = await this.store.entries();
    return Promise.all(
      entries
        .filter((entry) => filter?.group === undefined || entry.spec.group === filter.group)
        .map(async (entry) => ({
          ref: reference(entry),
          name: entry.spec.name,
          cwd: entry.spec.cwd,
          status: (await this.probe(reference(entry))).status,
        })),
    );
  }

  async probe(ref: SessionRef): Promise<Probe> {
    const entry = await this.store.owned(ref, true);
    if (entry.closed) return { status: "gone", shellInFront: false };
    return ref.id.startsWith("worker-") ? probeWorker(entry) : probeThread(this.connection, ref.id);
  }

  async read(ref: SessionRef, lines: number, _opts?: ReadOptions): Promise<string> {
    const entry = await this.store.owned(ref);
    return ref.id.startsWith("worker-")
      ? readWorker(this.store, entry, lines)
      : readThread(this.connection, ref.id, lines);
  }

  deliver(ref: SessionRef, prompt: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    return deliver(this.store, this.connection, ref, prompt, opts);
  }

  async submitTyped(ref: SessionRef, _into: AgentIdentity): Promise<SubmitResult> {
    await this.store.owned(ref);
    return "changed";
  }
  async typeIntoShell(ref: SessionRef, _text: string): Promise<boolean> {
    await this.store.owned(ref);
    return false;
  }
  async keys(ref: SessionRef, _keys: readonly Key[]): Promise<void> {
    await this.store.owned(ref);
    throw new CodexError("unsupported", "Codex runtime never sends terminal keys or interrupts desktop turns");
  }

  async close(ref: SessionRef, _scope?: CloseScope): Promise<void> {
    const entry = await this.store.owned(ref, true);
    if (entry.closed) return;
    if (ref.id.startsWith("worker-")) await closeWorker(entry);
    else await this.connection.call("thread/unsubscribe", { threadId: ref.id });
    await this.store.save({ ...entry, closed: true });
  }

  watchIdle(callback: (ref: SessionRef) => Promise<void>): Promise<() => void> {
    return watchIdle(this.store, this.connection, callback);
  }

  runReview(
    prompt: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<{ readonly stdout: string; readonly code: number; readonly stderr: string }> {
    return runReview(this.store, this.connection, this.env, prompt, model, signal);
  }

  /** Only an explicit operator ack/resend may resolve an uncertain admission. */
  async resolveDelivery(ref: SessionRef): Promise<void> {
    await this.store.owned(ref);
    const release = takeInboxLock(`${this.store.path(ref.id)}.submit-lock`, Date.now());
    if (!release) throw new CodexError("unsupported", "A submission is still in progress");
    try {
      const entry = await this.store.owned(ref);
      const { uncertain: _uncertain, ...resolved } = entry;
      await this.store.save(resolved);
    } finally {
      release();
    }
  }

  handoff(ref: SessionRef, toDesktop: boolean): Promise<void> {
    return handoff(this.store, this.connection, ref, toDesktop);
  }
}
