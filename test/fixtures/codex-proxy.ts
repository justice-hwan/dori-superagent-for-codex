import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function nativeFixture(socket: string, directory: string, threadId: string, mode: string) {
  return Bun.serve({
    unix: socket,
    fetch(request, server) {
      if (new URL(request.url).pathname !== "/rpc") return new Response("Wrong endpoint", { status: 404 });
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 426 });
    },
    websocket: {
      open() {
        appendFileSync(join(directory, "starts"), "websocket\n");
      },
      close(_socket, code) {
        appendFileSync(join(directory, "closed"), String(code) + "\n");
      },
      message(socket, data) {
        const frame: unknown = JSON.parse(String(data));
        if (!record(frame) || !record(frame["params"])) throw new Error("Malformed client request");
        appendFileSync(join(directory, "requests"), JSON.stringify(frame) + "\n");
        const params = frame["params"];
        const reply = (result: unknown, id: unknown = frame["id"]) => socket.send(JSON.stringify({ id, result }));
        const reject = (code = -32602, message = "Native request rejected") =>
          socket.send(JSON.stringify({ id: frame["id"], error: { code, message } }));
        switch (frame["method"]) {
          case "initialize":
            if (!record(params["capabilities"]) || params["capabilities"]["experimentalApi"] !== true)
              throw new Error("Queue requires experimental API capability");
            if (mode !== "stall-initialize") reply({ userAgent: "codex/0.167.2" });
            break;
          case "initialized":
            break;
          case "thread/read":
            if (mode === "disconnect-read") {
              socket.terminate();
              break;
            }
            if (mode === "read-rejected" || params["threadId"] !== threadId || params["includeTurns"] !== false) {
              reject();
              break;
            }
            reply({
              thread: {
                id: mode === "wrong-thread" ? "unrelated-thread" : mode === "malformed-thread" ? 123 : threadId,
                cwd: mode === "wrong-workspace" ? "/" : mode === "malformed-workspace" ? null : directory,
                status: {
                  type:
                    mode === "not-loaded"
                      ? "notLoaded"
                      : mode === "bad-status"
                        ? "unrecognized"
                        : mode === "active"
                          ? "active"
                          : "idle",
                ...(mode === "active" ? { activeFlags: [] } : {}),
                },
              },
            });
            break;
          case "thread/queue/add": {
            if (
              params["threadId"] !== threadId ||
              Object.keys(params).sort().join(",") !== "clientUserMessageId,input,threadId" ||
              typeof params["clientUserMessageId"] !== "string" ||
              !Array.isArray(params["input"])
            ) {
              reject();
              break;
            }
            if (mode === "rejected") {
              reject();
              break;
            }
            if (mode === "disconnect-queue") {
              socket.terminate();
              break;
            }
            writeFileSync(join(directory, "accepted"), JSON.stringify(params));
            if (mode === "accepted-error") {
              reject(-32603, "Native queue internal error");
              break;
            }
            if (mode === "disconnect-accepted") {
              socket.terminate();
              break;
            }
            if (mode === "stall-queue") break;
            const queuedSubmission = {
              id: mode === "ack-id" ? "" : "native-queue-17",
              input: mode === "ack-input" ? [{ type: "text", text: "different", text_elements: [] }] : params["input"],
              clientUserMessageId: mode === "ack-client" ? "different-client" : params["clientUserMessageId"],
            };
            if (mode === "ack-json") socket.send("invalid JSON");
            else reply({ queuedSubmission }, mode === "ack-rpc" ? 999 : frame["id"]);
            if (mode === "disconnect-ack") socket.close(1000);
            break;
          }
          default:
            throw new Error("Forbidden native operation: " + String(frame["method"]));
        }
      },
    },
  });
}
