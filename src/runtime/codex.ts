import { nativeGuard } from "../native-guard.ts";
import { NativeState } from "../native-state.ts";
import { Refusal } from "../refusal.ts";
import { readNativeThread, selectedNativeThread, queueNativeMessage, withNativeConnection } from "./codex-io.ts";
import { launchNative } from "./codex-launch.ts";
import { ensureNativeLoaded, nativeItems } from "./codex-session.ts";
import type { NativeSettings } from "./codex-settings.ts";
import { NativeIoError, type NativeConnection } from "./codex-transport.ts";
import { groupId } from "./group.ts";
import {
  parseRef,
  type AgentStatus,
  type CloseScope,
  type DeliverOptions,
  type DeliverOutcome,
  type NativeAgentResult,
  type NativeAgentRuntime,
  type NativeAgentSpec,
  type NativePrompt,
  type Probe,
  type ReadOptions,
  type SessionInfo,
  type SessionRef,
} from "./types.ts";

/** Native agents only. There are no terminal creation, shell, key or typed-submit methods. */
export class CodexRuntime implements NativeAgentRuntime {
  readonly kind = "codex";
  private readonly state;
  constructor(
    readonly home: string,
    readonly settings: NativeSettings,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.state = new NativeState(home);
  }

  private owned(ref: SessionRef) {
    if (ref.runtime !== "codex") throw new Refusal("not a native thread ref");
    return this.state.confirmed(ref.id, this.settings.socket, this.settings.fullAccess);
  }
  private created(ref: SessionRef) {
    if (ref.runtime !== "codex") throw new Refusal("not a native thread ref");
    return this.state.created(ref.id, this.settings.socket, this.settings.fullAccess);
  }
  assertOwned(ref: SessionRef): void {
    this.owned(ref);
  }
  assertCaller(ref: SessionRef): void {
    const owner = this.created(ref);
    if (owner.archived || owner.archiveState) throw new Refusal("native caller is archived or close is HELD");
  }
  self(): SessionRef | undefined {
    const ref = parseRef(this.env["DORI_SELF"] ?? "");
    if (ref?.runtime !== "codex") return undefined;
    this.assertCaller(ref);
    return ref;
  }
  launchAgent(spec: NativeAgentSpec, render: NativePrompt): Promise<SessionRef> {
    return launchNative(this.home, this.settings, spec, render);
  }
  async runAgent(spec: NativeAgentSpec, render: NativePrompt): Promise<NativeAgentResult> {
    let result: NativeAgentResult | undefined;
    await launchNative(this.home, this.settings, spec, render, async (connection, owner, completion) => {
      const turn = await completion;
      if (turn instanceof Error) throw turn;
      if (turn?.status !== "completed" || turn.error)
        throw new Refusal("native reviewer did not complete successfully");
      const output = turn.output;
      if (output.truncated) throw new Refusal("native review output exceeds bounded read; no receipt");
      const ref: SessionRef = { runtime: "codex", id: owner.threadId };
      this.state.save({ ...this.owned(ref), completionTurnId: turn.id });
      await this.archive(connection, ref);
      result = {
        ref: { runtime: "codex", id: owner.threadId },
        text: output.text,
        model: owner.model,
        modelProvider: owner.modelProvider,
      };
    });
    if (!result) throw new Refusal("native review result was not observed");
    return result;
  }
  async list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]> {
    if (filter?.group !== undefined && filter.group !== groupId(this.home)) return [];
    return this.state.launches().flatMap((owner) =>
      owner.threadId && !owner.archived
        ? [
            {
              ref: { runtime: this.kind, id: owner.threadId },
              name: owner.name,
              cwd: owner.cwd,
              status: "unknown" as const,
              agent: "codex",
            },
          ]
        : [],
    );
  }
  async probe(ref: SessionRef): Promise<Probe> {
    const owner = this.created(ref);
    if (owner.archived) return { status: "gone", shellInFront: false };
    if (owner.archiveState) return { status: "unknown", shellInFront: false, title: `${owner.name} (archive HELD)` };
    if (owner.state !== "accepted")
      return { status: "unknown", shellInFront: false, title: `${owner.name} (bootstrap ${owner.state})` };
    const metadata = await readNativeThread({ threadId: ref.id, cwd: owner.cwd }, this.settings);
    const states: Record<typeof metadata.status, AgentStatus> = {
      idle: "idle",
      active: "working",
      systemError: "error",
      notLoaded: "unknown",
    };
    return {
      status: metadata.blocked ? "blocked" : states[metadata.status],
      shellInFront: false,
      agent: "codex",
      cwd: metadata.cwd,
      title: metadata.status === "notLoaded" ? `${owner.name} (notLoaded)` : owner.name,
    };
  }
  async read(ref: SessionRef, lines: number, _opts?: ReadOptions): Promise<string> {
    const owner = this.owned(ref);
    return withNativeConnection(this.settings, async (connection) => {
      await selectedNativeThread(connection, { threadId: ref.id, cwd: owner.cwd });
      const result = await nativeItems(connection, owner.threadId, { lines });
      return `${result.truncated ? "[native history truncated]\n" : ""}${result.text}`;
    });
  }
  async deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome> {
    if (opts?.force || opts?.when === "working")
      throw new Refusal("native delivery does not force or steer an active turn");
    let outcome: DeliverOutcome | undefined;
    try {
      const routing = this.created(ref);
      const lease = await nativeGuard(this.home, `agent:${routing.key}`);
      try {
        const owner = this.owned(ref);
        if (owner.archived) return { kind: "no-agent" };
        if (owner.archiveState) throw new Refusal("native archive is pending/HELD; no input sent");
        return await withNativeConnection(this.settings, async (connection) => {
          await ensureNativeLoaded(connection, owner, this.state);
          const result = await queueNativeMessage(
            { threadId: ref.id, cwd: owner.cwd },
            { text, clientUserMessageId: crypto.randomUUID() },
            this.settings,
            connection,
          );
          switch (result.kind) {
            case "accepted":
              outcome = { kind: "delivered", acceptedQueueId: result.queueId };
              break;
            case "rejected":
              outcome = { kind: "not-ready", status: "unknown" };
              break;
            case "unknown":
              outcome = {
                kind: "ambiguous",
                detail: result.detail,
                failure: new NativeIoError("transport", result.detail),
              };
              break;
            default: {
              const never: never = result;
              throw new Error(String(never));
            }
          }
          return outcome;
        });
      } finally {
        await lease[Symbol.asyncDispose]();
      }
    } catch (error) {
      if (outcome) return outcome;
      if (error instanceof NativeIoError || error instanceof Refusal) return { kind: "not-ready", status: "unknown" };
      throw error;
    }
  }
  private async archive(connection: NativeConnection, ref: SessionRef) {
    const owner = this.owned(ref);
    if (owner.archived) return;
    if (owner.archiveState) throw new Refusal("HELD native archive; no automatic archive replay");
    const metadata = await selectedNativeThread(connection, { threadId: owner.threadId, cwd: owner.cwd });
    if (metadata.status === "active" || metadata.status === "systemError")
      throw new Refusal(`native thread is ${metadata.status}; archive refused`);
    this.state.save({ ...owner, archiveState: "pending" });
    try {
      await connection.request("thread/archive", { threadId: owner.threadId });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.state.save({ ...owner, archiveState: "held", detail: error.message });
      throw error;
    }
    // A local post-ACK persistence error must not overwrite a newer canonical closed outcome.
    this.state.save({ ...owner, archived: true });
  }
  async close(ref: SessionRef, scope: CloseScope = "session"): Promise<void> {
    if (scope !== "session") throw new Refusal("native threads have no terminal container");
    const routing = this.created(ref);
    const lease = await nativeGuard(this.home, `agent:${routing.key}`);
    try {
      const current = this.owned(ref);
      if (current.archived) return;
      if (current.archiveState) throw new Refusal("HELD native archive; no automatic archive replay");
      await withNativeConnection(this.settings, (connection) => this.archive(connection, ref));
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  }
}
