import type { ServerWebSocket } from "bun";
import { record } from "../src/runtime/codex-transport.ts";
import { nativePolicyReply } from "./native-policy.ts";

type Item = { turnId: string; item: Record<string, unknown> };
type Thread = {
  id: string;
  cwd: string;
  model: string;
  status: string;
  flags?: string[];
  archived: boolean;
  fullAccess: boolean;
  items: Item[];
};
export function nativeServer(socket: string, mode = "normal") {
  const threads = new Map<string, Thread>();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queued: Record<string, unknown>[] = [];
  const connections = new Set<ServerWebSocket<{ thread?: string }>>();
  const arrivals = new Set<{ count: number; resolve: () => void }>();
  const pending: (() => void)[] = [];
  const readStarted = Promise.withResolvers<void>();
  const archiveStarted = Promise.withResolvers<void>();
  const complete = (id: string, text = "Native response\nVERDICT: CLEAR") => {
    const thread = threads.get(id);
    if (!thread) throw new Error("Missing fake thread");
    const user = thread.items.findLast((entry) => entry.item["type"] === "userMessage");
    if (!user) throw new Error("Fake completion has no user input");
    const turnId = user.turnId;
    thread.items.push({ turnId, item: { id: `agent-${turnId}`, type: "agentMessage", text } });
    thread.status = "idle";
    for (const peer of connections)
      if (peer.data.thread === id)
        peer.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: id, turn: { id: turnId, status: "completed", error: null } },
          }),
        );
  };
  const server = Bun.serve<{ thread?: string }>({
    unix: socket,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/rpc") return new Response("Wrong path", { status: 404 });
      if (server.upgrade(request, { data: {} })) return;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      open(peer) {
        connections.add(peer);
      },
      close(peer) {
        connections.delete(peer);
      },
      message(peer, data) {
        const request: unknown = JSON.parse(String(data));
        if (!record(request) || !record(request["params"]) || typeof request["method"] !== "string")
          throw new Error("Invalid native request");
        const params = request["params"];
        calls.push({ method: request["method"], params });
        const reply = (result: object) => peer.send(JSON.stringify({ id: request["id"], result }));
        const reject = (message: string) =>
          peer.send(
            JSON.stringify({
              id: request["id"],
              error: { code: -32603, message },
            }),
          );
        const id = params["threadId"];
        const thread = typeof id === "string" ? threads.get(id) : undefined;
        switch (request["method"]) {
          case "initialize":
            reply({ userAgent: "codex/0.167.2" });
            break;
          case "initialized":
            break;
          case "thread/start": {
            if (typeof params["cwd"] !== "string" || typeof params["model"] !== "string")
              throw new Error("Missing launch fields");
            const id = crypto.randomUUID();
            const thread: Thread = {
              id,
              cwd: params["cwd"],
              model: params["model"],
              status: "idle",
              archived: false,
              fullAccess: false,
              items: [],
            };
            threads.set(id, thread);
            peer.data.thread = id;
            if (mode === "lost-create") {
              peer.terminate();
              break;
            }
            const admission = nativePolicyReply(thread, params, mode);
            thread.fullAccess =
              admission.sandbox?.["type"] === "dangerFullAccess" && admission.approvalPolicy === "never";
            reply(admission);
            break;
          }
          case "thread/name/set":
            if (!thread) throw new Error("Wrong name target");
            reply({});
            break;
          case "thread/read": {
            if (!thread || params["includeTurns"] !== false) throw new Error("Wrong metadata read");
            const metadata = () =>
              reply({
                thread: {
                  id,
                  cwd: thread.cwd,
                  status: {
                    type: thread.archived ? "notLoaded" : thread.status,
                    ...(thread.status === "active" ? { activeFlags: thread.flags ?? [] } : {}),
                  },
                },
              });
            if (mode === "hold-read") {
              mode = "normal";
              pending.push(metadata);
              readStarted.resolve();
            } else metadata();
            break;
          }
          case "thread/resume": {
            if (
              !thread ||
              params["excludeTurns"] !== true ||
              Object.keys(params).sort().join(",") !==
                (params["sandbox"] ? "approvalPolicy,excludeTurns,sandbox,threadId" : "excludeTurns,threadId")
            )
              throw new Error("Unsafe or unbounded resume");
            thread.status = "idle";
            const admission = nativePolicyReply(thread, params, mode === "lost-resume" ? "policy-sandbox" : mode);
            thread.fullAccess =
              admission.sandbox?.["type"] === "dangerFullAccess" && admission.approvalPolicy === "never";
            if (mode === "lost-resume") peer.terminate();
            else reply(admission);
            break;
          }
          case "thread/queue/add": {
            if (!thread || !Array.isArray(params["input"])) throw new Error("Wrong queue target");
            if (mode === "require-full-access" && !thread.fullAccess) {
              reject("Full access was not admitted");
              break;
            }
            queued.push(params);
            const turnId = `turn-${thread.items.length}`;
            thread.items.push({
              turnId,
              item: {
                id: `user-${turnId}`,
                type: "userMessage",
                clientId: params["clientUserMessageId"],
                content: params["input"],
              },
            });
            const finish = () => {
              if (mode === "accepted-error") reject("Accepted then internal error");
              else
                reply({
                  queuedSubmission: {
                    id: `queue-${queued.length}`,
                    input: params["input"],
                    clientUserMessageId: mode === "bad-client" ? "wrong" : params["clientUserMessageId"],
                  },
                });
              thread.status = "active";
              if (mode !== "never-complete" && mode !== "accepted-error") complete(thread.id);
            };
            if (
              (mode === "hold-loop" && queued.length > 2) ||
              (mode === "hold-send" && queued.length > 1) ||
              (mode === "hold-first" && queued.length === 1)
            )
              pending.push(finish);
            else finish();
            for (const arrival of arrivals)
              if (queued.length >= arrival.count) {
                arrivals.delete(arrival);
                arrival.resolve();
              }
            break;
          }
          case "thread/items/list": {
            if (!thread || typeof params["limit"] !== "number" || params["sortDirection"] !== "desc")
              throw new Error("Unbounded or wrong item read");
            const items = thread.items
              .filter((x) => params["turnId"] == null || x.turnId === params["turnId"])
              .toReversed();
            const offset = Number(params["cursor"] ?? "0");
            const data = items.slice(offset, offset + params["limit"]);
            reply({
              data,
              nextCursor: offset + data.length < items.length ? String(offset + data.length) : null,
              backwardsCursor: null,
            });
            break;
          }
          case "thread/archive":
            if (!thread) throw new Error("Wrong archive target");
            if (mode === "hold-archive") {
              thread.archived = true;
              pending.push(() => reply({}));
              archiveStarted.resolve();
            } else if (mode === "archive-accepted-error") {
              thread.archived = true;
              reject("Archived then internal error");
            } else if (mode === "archive-error") reject("Archive refused");
            else {
              thread.archived = true;
              reply({});
            }
            break;
          default:
            throw new Error(`Forbidden native RPC ${request["method"]}`);
        }
      },
    },
  });
  const waitQueued = (count: number) =>
    new Promise<void>((resolve) => {
      if (queued.length >= count) resolve();
      else arrivals.add({ count, resolve });
    });
  const releaseQueued = () => {
    for (const finish of pending.splice(0)) finish();
  };
  const setMode = (next: string) => {
    mode = next;
  };
  return {
    server,
    threads,
    calls,
    queued,
    connections,
    complete,
    waitQueued,
    releaseQueued,
    setMode,
    waitRead: () => readStarted.promise,
    waitArchive: () => archiveStarted.promise,
  };
}
