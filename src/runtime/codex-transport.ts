import { isAbsolute } from "node:path";

export type NativeSocketOptions = { readonly socket: string; readonly timeoutMs?: number };
export class NativeIoError extends Error {
  constructor(
    readonly kind: "transport" | "protocol" | "identity" | "remote",
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void };

/** Native Unix WebSocket /rpc transport; never starts or owns the shared daemon. */
export class NativeConnection {
  private readonly socket;
  private readonly terminate: () => void;
  private readonly opening = Promise.withResolvers<NativeIoError | undefined>();
  private readonly closing = Promise.withResolvers<void>();
  private readonly pending = new Map<number, Pending>();
  private readonly deadline;
  private sequence = 0;
  private failure: NativeIoError | undefined;
  readonly closed = this.closing.promise;

  constructor(options: NativeSocketOptions, notification?: (method: string, params: unknown) => void) {
    const timeoutMs = options.timeoutMs ?? 5000;
    if (!isAbsolute(options.socket) || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new NativeIoError("protocol", "Native connection requires an absolute socket and positive deadline");
    this.socket = new WebSocket(`ws+unix://${options.socket}:/rpc`);
    // lib.dom hides Bun's native termination extension; validate it at this boundary.
    const terminate: unknown = Reflect.get(this.socket, "terminate");
    if (typeof terminate !== "function") throw new NativeIoError("protocol", "Bun WebSocket termination is required");
    this.terminate = () => terminate.call(this.socket);
    this.socket.addEventListener("open", () => this.opening.resolve(undefined));
    this.socket.addEventListener("error", () => this.fail(new NativeIoError("transport", "Native WebSocket failed")));
    this.socket.addEventListener("close", () => {
      clearTimeout(this.deadline);
      this.fail(new NativeIoError("transport", "Native WebSocket closed"));
      this.closing.resolve();
    });
    this.socket.addEventListener("message", (event) => {
      // The official remote client ignores binary/control messages; JSON-RPC uses text.
      if (typeof event.data !== "string") return;
      try {
        const frame: unknown = JSON.parse(event.data);
        if (!record(frame)) throw new NativeIoError("protocol", "Native response is not an object");
        if (typeof frame["method"] === "string") {
          if (!("id" in frame)) notification?.(frame["method"], frame["params"]);
          return;
        }
        const id = frame["id"];
        if (typeof id !== "number") throw new NativeIoError("protocol", "Native response identity changed");
        const pending = this.pending.get(id);
        if (!pending) throw new NativeIoError("protocol", "Native response identity changed");
        if ("result" in frame && !("error" in frame)) {
          this.pending.delete(id);
          pending.resolve(frame["result"]);
          return;
        }
        const error = frame["error"];
        if (
          !("result" in frame) &&
          record(error) &&
          typeof error["code"] === "number" &&
          Number.isInteger(error["code"]) &&
          typeof error["message"] === "string"
        ) {
          this.pending.delete(id);
          pending.reject(new NativeIoError("remote", error["message"], error["code"]));
          return;
        }
        throw new NativeIoError("protocol", "Native response omitted a valid result or error");
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.fail(
          error instanceof NativeIoError
            ? error
            : new NativeIoError("protocol", "Native response is invalid JSON or notification"),
        );
      }
    });
    this.deadline = setTimeout(
      () => this.fail(new NativeIoError("transport", "Native WebSocket deadline reached")),
      timeoutMs,
    );
  }

  private fail(error: NativeIoError): void {
    this.failure ??= error;
    this.opening.resolve(this.failure);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (this.socket.readyState !== WebSocket.CLOSED) this.terminate();
  }

  async write(frame: object): Promise<void> {
    await this.opening.promise;
    if (this.failure) throw this.failure;
    this.socket.send(JSON.stringify(frame));
  }

  async request(method: string, params: object): Promise<unknown> {
    await this.opening.promise;
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const response = Promise.withResolvers<unknown>();
    this.pending.set(id, response);
    const [, result] = await Promise.all([this.write({ id, method, params }), response.promise]);
    return result;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000);
    else if (this.socket.readyState === WebSocket.CONNECTING) this.terminate();
    await this.closed;
  }
}
