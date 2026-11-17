import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { NativeConnection, NativeIoError, type NativeSocketOptions, record } from "./codex-transport.ts";
export { NativeIoError } from "./codex-transport.ts";

export type NativeThread = {
  readonly threadId: string;
  readonly cwd: string;
  readonly status: "notLoaded" | "idle" | "systemError" | "active";
  readonly blocked?: true;
};
type SelectedThread = { readonly threadId: string; readonly cwd: string };
type NativeMessage = { readonly text: string; readonly clientUserMessageId: string };
export type QueueOutcome =
  | { readonly kind: "accepted"; readonly queueId: string; readonly clientUserMessageId: string }
  | { readonly kind: "rejected"; readonly detail: string }
  | {
      readonly kind: "unknown";
      readonly disposition: "HELD";
      readonly clientUserMessageId: string;
      readonly detail: string;
    };

export async function withNativeConnection<T>(
  options: NativeSocketOptions,
  action: (proxy: NativeConnection) => Promise<T>,
  notification?: (method: string, params: unknown) => void,
): Promise<T> {
  await using proxy = new NativeConnection(options, notification);
  const initialized = await proxy.request("initialize", {
    clientInfo: { name: "dori-native-io", title: "Dori", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  if (!record(initialized) || typeof initialized["userAgent"] !== "string")
    throw new NativeIoError("protocol", "Native initialization response changed");
  await proxy.write({ method: "initialized", params: {} });
  return await action(proxy);
}

export async function selectedNativeThread(proxy: NativeConnection, target: SelectedThread): Promise<NativeThread> {
  const response = await proxy.request("thread/read", { threadId: target.threadId, includeTurns: false });
  const thread = record(response) ? response["thread"] : undefined;
  if (!record(thread) || thread["id"] !== target.threadId || typeof thread["cwd"] !== "string")
    throw new NativeIoError("identity", "Selected native thread identity changed");
  const cwd = thread["cwd"];
  if (!isAbsolute(cwd) || !isAbsolute(target.cwd) || realpathSync(cwd) !== realpathSync(target.cwd))
    throw new NativeIoError("identity", "Selected native thread workspace changed");
  const status = record(thread["status"]) ? thread["status"]["type"] : undefined;
  switch (status) {
    case "notLoaded":
    case "idle":
    case "systemError":
      return { threadId: target.threadId, cwd, status };
    case "active": {
      const flags = record(thread["status"]) ? thread["status"]["activeFlags"] : undefined;
      if (
        !Array.isArray(flags) ||
        flags.some((flag: unknown) => flag !== "waitingOnApproval" && flag !== "waitingOnUserInput")
      )
        throw new NativeIoError("protocol", "Selected native active flags changed");
      return { threadId: target.threadId, cwd, status, ...(flags.length ? { blocked: true } : {}) };
    }
    default:
      throw new NativeIoError("protocol", "Selected native thread status changed");
  }
}

/** Metadata only: no listing, creation, subscription or resume of any thread. */
export async function readNativeThread(target: SelectedThread, options: NativeSocketOptions): Promise<NativeThread> {
  return withNativeConnection(options, (proxy) => selectedNativeThread(proxy, target));
}

/** rust-v0.167.2 protocol/v2/thread.rs: QueuedSubmission and ThreadQueueAddParams/Response. */
export async function queueNativeMessage(
  target: SelectedThread,
  message: NativeMessage,
  options: NativeSocketOptions,
  connection?: NativeConnection,
): Promise<QueueOutcome> {
  let submitted = false;
  try {
    const submit = async (proxy: NativeConnection): Promise<QueueOutcome> => {
      const thread = await selectedNativeThread(proxy, target);
      switch (thread.status) {
        case "notLoaded":
        case "systemError":
          throw new NativeIoError("identity", `Selected native thread is ${thread.status}; no resume attempted`);
        case "idle":
        case "active":
          break;
        default: {
          const never: never = thread.status;
          throw new NativeIoError("protocol", String(never));
        }
      }
      const input = [{ type: "text", text: message.text, text_elements: [] }];
      submitted = true;
      const response = await proxy.request("thread/queue/add", {
        threadId: target.threadId,
        input,
        clientUserMessageId: message.clientUserMessageId,
      });
      const queued = record(response) ? response["queuedSubmission"] : undefined;
      const item = record(queued) && Array.isArray(queued["input"]) ? queued["input"][0] : undefined;
      if (
        !record(queued) ||
        typeof queued["id"] !== "string" ||
        queued["id"].length === 0 ||
        queued["clientUserMessageId"] !== message.clientUserMessageId ||
        !Array.isArray(queued["input"]) ||
        queued["input"].length !== 1 ||
        !record(item) ||
        item["type"] !== "text" ||
        item["text"] !== message.text ||
        !Array.isArray(item["text_elements"]) ||
        item["text_elements"].length !== 0
      )
        throw new NativeIoError("protocol", "Native queue acknowledgement changed");
      return { kind: "accepted", queueId: queued["id"], clientUserMessageId: message.clientUserMessageId };
    };
    return await (connection ? submit(connection) : withNativeConnection(options, submit));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // An RPC error after a write attempt does not prove that native persistence failed.
    if (submitted)
      return {
        kind: "unknown",
        disposition: "HELD",
        clientUserMessageId: message.clientUserMessageId,
        detail: error.message,
      };
    return { kind: "rejected", detail: error.message };
  }
}
