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
  DeliveryBatch,
  Key,
  Probe,
  ReadOptions,
  SessionInfo,
  SessionRef,
  SessionRuntime,
  SubmitResult,
} from "../types.ts";
import { NativeStartUncertain } from "../types.ts";
import {
  assertAdmittedMcpServers,
  disabledConfiguredMcpServers,
  pinHostRuntime,
  prepareBridge,
  trustedPath,
} from "./bridge-install.ts";
import { CodexConnection, CodexError, object, text } from "./protocol.ts";
import { deliver, handoff } from "./delivery.ts";
import { refuseAdmittedThread, runReview } from "./review.ts";
import { CodexStore, reference } from "./store.ts";
import { defaultCommand, probeThread, readThread, startParams, type Environment } from "./threads.ts";
import { watchIdle } from "./watch.ts";
import { closeWorker, probeWorker, readWorker, startWorker } from "./workers.ts";
import { acknowledgeDelivery, confirmedDelivery } from "./inbox-journal.ts";

/** Shared-daemon client. Closing Dori sessions never stops the desktop daemon. */
export class CodexRuntime implements SessionRuntime {
  readonly kind = "codex";
  private readonly store: CodexStore;
  private readonly connection: CodexConnection;
  private env: Environment;

  constructor(root: string, env?: Environment) {
    const inherited = env ?? process.env;
    this.env = {
      ...inherited,
      DORI_CMD: inherited["DORI_CMD"] || defaultCommand,
    };
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

  prepareHost(cwd: string) {
    trustedPath(this.store.root, cwd);
    const host = pinHostRuntime(cwd, this.env);
    this.env = { ...this.env, DORI_CMD: host.command };
    return host;
  }

  async create(spec: CreateSpec): Promise<SessionRef> {
    this.prepareHost(spec.cwd);
    const worker = spec.role === "duty-loop" || spec.role === "hourly-loop";
    const bridge =
      !worker && this.env["DORI_CODEX_BRIDGE"] === "stdio" ? prepareBridge(this.store.root, spec, this.env) : undefined;
    const params = startParams(this.store.root, spec, this.env);
    let response: Record<string, unknown> | undefined;
    try {
      const config: Record<string, unknown> = { ...object(params["config"]), ...bridge?.config };
      if (bridge)
        config["mcp_servers"] = {
          ...(await disabledConfiguredMcpServers(this.connection, spec.cwd)),
          ...object(bridge.config.mcp_servers),
        };
      response = worker ? undefined : object(await this.connection.call("thread/start", { ...params, config }));
      if (bridge && response) {
        const started = { id: text(object(response["thread"])["id"]), spec, closed: false };
        await this.store.save(started);
        const allowed = new Set(Object.keys(object(config["mcp_servers"])));
        const deadline = Number(this.env["DORI_CODEX_REVIEW_TIMEOUT_MS"] || 120_000);
        try {
          await assertAdmittedMcpServers(this.connection, spec.cwd, started.id, allowed, deadline);
        } catch (error) {
          await refuseAdmittedThread(this.connection, this.store, started, error);
        }
      }
    } catch (error) {
      bridge?.discard();
      throw error;
    }
    const id = response ? text(object(response["thread"])["id"]) : `worker-${crypto.randomUUID()}`;
    const entry = { id, spec, closed: false };
    await this.store.save(entry);
    bridge?.bind(id);
    if (!worker)
      await this.connection.call("thread/name/set", {
        threadId: id,
        name: `Dori ${spec.role}: ${spec.name}`,
      });
    return reference(entry);
  }

  async start(ref: SessionRef, command: string): Promise<void> {
    await this.store.owned(ref);
    if (!ref.id.startsWith("worker-"))
      throw new CodexError("unsupported", "Agent prompts require startAgent, never a shell command");
    const release = takeInboxLock(`${this.store.path(ref.id)}.submit-lock`, Date.now());
    if (!release) throw new CodexError("unsupported", "A submission is still in progress");
    try {
      const entry = await this.store.owned(ref);
      await startWorker(this.store, entry, command, this.env, this.prepareHost(entry.spec.cwd));
    } finally {
      release();
    }
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

  confirmedDelivery(ref: SessionRef): Promise<DeliveryBatch | undefined> {
    return confirmedDelivery(this.store, ref);
  }

  acknowledgeDelivery(ref: SessionRef, batchId: string): Promise<void> {
    return acknowledgeDelivery(this.store, ref, batchId);
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
    await this.store.owned(ref, true);
    const release = takeInboxLock(`${this.store.path(ref.id)}.submit-lock`, Date.now());
    if (!release) throw new CodexError("unsupported", "A submission is still in progress");
    try {
      const entry = await this.store.owned(ref, true);
      if (entry.closed) return;
      if (ref.id.startsWith("worker-")) await closeWorker(entry);
      else await this.connection.call("thread/unsubscribe", { threadId: ref.id });
      await this.store.save({ ...entry, closed: true });
    } finally {
      release();
    }
  }

  watchIdle(callback: (ref: SessionRef) => Promise<void>): Promise<() => void> {
    return watchIdle(this.store, this.connection, callback);
  }

  runReview(
    prompt: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly stdout: string;
    readonly code: number;
    readonly stderr: string;
  }> {
    this.prepareHost(this.env["DORI_CODEX_WORKSPACE"] || process.cwd());
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
