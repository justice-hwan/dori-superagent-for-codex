import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { nativeGuard } from "../native-guard.ts";
import { NativeState, type NativeOwner } from "../native-state.ts";
import { Refusal } from "../refusal.ts";
import { queueNativeMessage, withNativeConnection } from "./codex-io.ts";
import { ensureNativeLoaded } from "./codex-session.ts";
import { nativeItems } from "./codex-session.ts";
import { hasFullAccess, nativePolicy, type NativeSettings } from "./codex-settings.ts";
import { record, type NativeConnection } from "./codex-transport.ts";
import { parseRef, type NativeAgentSpec, type NativePrompt, type SessionRef } from "./types.ts";

type Completion = { id: string; status: string; error: boolean };
type VerifiedCompletion = Completion & { output: { text: string; truncated: boolean } };
export type AcceptedAgent = NativeOwner & { threadId: string; modelProvider: string };
type AfterAccepted = (
  connection: NativeConnection,
  owner: AcceptedAgent,
  turn: Promise<VerifiedCompletion | Error | undefined>,
) => Promise<void>;

/** One logical launch, serialized by an OS binding. Pending/HELD never creates or submits again. */
export async function launchNative(
  home: string,
  settings: NativeSettings,
  spec: NativeAgentSpec,
  render: NativePrompt,
  after?: AfterAccepted,
): Promise<SessionRef> {
  const lease = await nativeGuard(home, `agent:${spec.key}`);
  try {
    const state = new NativeState(home);
    const model = spec.model ?? settings.model;
    if (!model.startsWith("gpt-")) throw new Refusal("native reasoning requires an explicit GPT model");
    const cwd = realpathSync(spec.cwd);
    const previous = state.launch(spec.key);
    if (previous && !previous.archived) {
      if (previous.state !== "accepted" || !previous.threadId || previous.archiveState)
        throw new Refusal(`HELD native bootstrap ${spec.key}: ${previous.state}; no replacement or resend`);
      const owner = state.confirmed(previous.threadId, settings.socket, settings.fullAccess);
      if (owner.cwd !== cwd || owner.model !== model || after)
        throw new Refusal("existing native launch cannot be replaced or replayed");
      const ref: SessionRef = { runtime: "codex", id: owner.threadId };
      const text = await render(ref, owner.model);
      if (createHash("sha256").update(text).digest("hex") !== owner.promptHash)
        throw new Refusal("accepted native bootstrap instructions changed; no replay");
      await withNativeConnection(settings, async (connection) => {
        const metadata = await ensureNativeLoaded(connection, owner, state);
        if (metadata.status !== "idle" && metadata.status !== "active")
          throw new Refusal("owned native agent is not available");
      });
      return ref;
    }
    let owner: NativeOwner = {
      key: spec.key,
      name: spec.name,
      cwd,
      socket: settings.socket,
      model,
      clientUserMessageId: crypto.randomUUID(),
      state: "pending",
      fullAccess: settings.fullAccess === true,
    };
    state.save(owner);
    const completed = Promise.withResolvers<VerifiedCompletion | Error | undefined>();
    let verifyCompletion: ((turn: Completion) => Promise<void>) | undefined;
    try {
      return await withNativeConnection(
        { ...settings, timeoutMs: after ? settings.turnTimeoutMs : settings.timeoutMs },
        async (connection) => {
          void connection.closed.then(() => completed.resolve(undefined));
          const created = await connection.request("thread/start", {
            cwd,
            model,
            ephemeral: false,
            threadSource: "user",
            ...(settings.fullAccess ? { sandbox: "danger-full-access", approvalPolicy: "never" } : {}),
          });
          const thread = record(created) ? created["thread"] : undefined;
          if (
            !record(created) ||
            !record(thread) ||
            typeof thread["id"] !== "string" ||
            typeof created["cwd"] !== "string" ||
            typeof created["model"] !== "string" ||
            typeof created["modelProvider"] !== "string"
          )
            throw new Refusal("native creation response identity changed");
          const ref = parseRef(`codex:${thread["id"]}`);
          if (ref?.runtime !== "codex") throw new Refusal("native creation returned an invalid thread id");
          owner = {
            ...owner,
            threadId: ref.id,
            cwd: created["cwd"],
            model: created["model"],
            modelProvider: created["modelProvider"],
            policy: nativePolicy(created),
          };
          state.save(owner);
          if (settings.fullAccess && !hasFullAccess(owner.policy))
            throw new Refusal("HELD native full-access policy/approval was not admitted");
          if (realpathSync(owner.cwd) !== cwd || owner.model !== model)
            throw new Refusal("native creation workspace/model changed");
          owner = { ...owner, creationConfirmed: true };
          await connection.request("thread/name/set", { threadId: ref.id, name: spec.name });
          const text = await render(ref, owner.model);
          const promptHash = createHash("sha256").update(text).digest("hex");
          owner = { ...owner, promptHash };
          state.save(owner);
          if (after)
            verifyCompletion = async (turn) => {
              try {
                const output = await nativeItems(connection, ref.id, {
                  lines: 500,
                  review: { turnId: turn.id, clientUserMessageId: owner.clientUserMessageId, promptHash },
                });
                if (output.matchesInput) completed.resolve({ ...turn, output });
              } catch (error) {
                if (!(error instanceof Error)) throw error;
                completed.resolve(error);
              }
            };
          const queue = await queueNativeMessage(
            { threadId: ref.id, cwd },
            { text, clientUserMessageId: owner.clientUserMessageId },
            settings,
            connection,
          );
          if (queue.kind !== "accepted") throw new Refusal(`initial native queue ${queue.kind}: ${queue.detail}`);
          owner = { ...owner, state: "accepted", queueId: queue.queueId };
          state.save(owner);
          if (after)
            await after(
              connection,
              { ...owner, threadId: ref.id, modelProvider: created["modelProvider"] },
              completed.promise,
            );
          return ref;
        },
        (method, params) => {
          if (
            !verifyCompletion ||
            method !== "turn/completed" ||
            !record(params) ||
            params["threadId"] !== owner.threadId
          )
            return;
          const turn = params["turn"];
          if (!record(turn) || typeof turn["id"] !== "string" || typeof turn["status"] !== "string")
            throw new Refusal("selected native completion changed");
          void verifyCompletion({ id: turn["id"], status: turn["status"], error: turn["error"] != null });
        },
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (owner.state !== "accepted") state.save({ ...owner, state: "held", detail: error.message });
      throw new Refusal(
        `${owner.state === "accepted" ? "Native input accepted; later operation failed" : "HELD native bootstrap"} ${spec.key}: ${error.message}`,
      );
    }
  } finally {
    await lease[Symbol.asyncDispose]();
  }
}
