/** Small boundary parsers keep daemon data out of the runtime's internal contracts. */
/** How long connecting to the shared daemon may take; also bounds the idle watcher's readiness handshake. */
export const CONNECT_TIMEOUT_MS = 10_000;

export class CodexError extends Error {
  constructor(
    readonly kind: "remote" | "protocol" | "transport" | "ownership" | "unsupported" | "uncertain",
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "CodexError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) throw new CodexError("protocol", "Expected a Codex object");
  return value;
};
export const text = (value: unknown): string => {
  if (typeof value !== "string") throw new CodexError("protocol", "Expected Codex text");
  return value;
};
export const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new CodexError("protocol", "Expected a Codex array");
  return value;
};

export type Notification = { readonly method: string; readonly params: Record<string, unknown> };
type Pending = { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void };

/** One JSON-RPC message per WebSocket frame, using the existing desktop daemon. */
export class CodexConnection {
  private socket: WebSocket | undefined;
  private opening: Promise<void> | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  readonly listeners = new Set<(event: Notification) => void>();
  readonly disconnections = new Set<() => void>();

  constructor(private readonly address: string) {}

  private async connect(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const opening = this.open();
    this.opening = opening;
    try {
      await opening;
    } catch (error) {
      this.socket?.close();
      this.socket = undefined;
      throw error;
    } finally {
      this.opening = undefined;
    }
  }

  private async open(): Promise<void> {
    const socket = new WebSocket(this.address);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const frame = object(JSON.parse(String(event.data)));
        if (typeof frame["id"] === "number" && !frame["method"]) {
          const pending = this.pending.get(frame["id"]);
          if (!pending) return;
          this.pending.delete(frame["id"]);
          if (frame["error"]) {
            const error = object(frame["error"]);
            pending.reject(
              new CodexError(
                "remote",
                text(error["message"]),
                typeof error["code"] === "number" ? error["code"] : undefined,
              ),
            );
          } else if ("result" in frame) pending.resolve(frame["result"]);
          else pending.reject(new CodexError("protocol", "Codex response omitted result"));
        } else if (typeof frame["method"] === "string" && !("id" in frame)) {
          const notification = { method: frame["method"], params: object(frame["params"] ?? {}) };
          for (const listener of this.listeners) listener(notification);
        }
        // Server approval/tool requests belong to the desktop. Never answer them.
      } catch (error) {
        this.fail(error instanceof Error ? error : new CodexError("protocol", String(error)));
        socket.close();
      }
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.fail(new CodexError("transport", "Codex connection closed; submitted requests may have been accepted"));
      }
      for (const listener of this.disconnections) listener();
    });
    socket.addEventListener("error", () => {
      if (this.socket === socket) this.fail(new CodexError("transport", "Codex connection failed"));
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new CodexError("transport", "Connecting to shared Codex daemon timed out"));
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new CodexError("transport", "Cannot connect to shared Codex daemon"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timeout);
          reject(new CodexError("transport", "Codex closed before initialization"));
        },
        { once: true },
      );
    });
    await this.send("initialize", {
      clientInfo: { name: "dori", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new CodexError("transport", "Codex is disconnected");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError("transport", `Codex ${method} timed out; outcome may be unknown`));
        socket.close();
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new CodexError("transport", `Codex send failed: ${String(error)}`));
      }
    });
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connect();
    return this.send(method, params);
  }

  disconnect(): void {
    this.socket?.close();
    this.fail(new CodexError("transport", "Dori disconnected from Codex"));
  }
}
