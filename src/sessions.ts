import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "gone";
export interface SessionRuntime {
  known(threadId: string): boolean;
  create(name: string, cwd: string, instructions: string, model?: string): Promise<string>;
  status(threadId: string): Promise<AgentStatus>;
  deliver(threadId: string, text: string, deliveryId?: string): Promise<void>;
  read(threadId: string): Promise<string>;
  close(threadId: string): Promise<void>;
  review(text: string, cwd: string, model?: string): Promise<string>;
}

export const validThread = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
// Unix sockets have a short platform limit; private state directories may have very long names.
export const socketPath = (home: string) => join(tmpdir(), `dori-codex-${process.getuid?.() ?? "user"}-${createHash("sha256").update(home).digest("hex").slice(0, 16)}.sock`);

export class Sessions implements SessionRuntime {
  constructor(readonly home: string) {}
  known(id: string): boolean { return validThread(id) && existsSync(join(this.home, "sessions", `${id}.json`)); }

  async call<T = any>(method: string, args: unknown = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch("http://localhost/rpc", { unix: socketPath(this.home), method: "POST", body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(method === "review" ? 1_210_000 : 35_000) });
    } catch { throw new Error("Dori runtime unavailable or request timed out; inspect status before retrying (start with dori-codex up)"); }
    const result = await response.json() as { value?: T; error?: string };
    if (!response.ok || result.error) throw new Error(result.error ?? "Dori runtime request failed");
    return result.value as T;
  }

  create(name: string, cwd: string, instructions: string, model?: string): Promise<string> { return this.call("create", { name, cwd, instructions, model }); }
  status(threadId: string): Promise<AgentStatus> { return this.call("status", { threadId }); }
  async deliver(threadId: string, text: string, deliveryId?: string): Promise<void> { await this.call("deliver", { threadId, text, deliveryId }); }
  read(threadId: string): Promise<string> { return this.call("read", { threadId }); }
  async close(threadId: string): Promise<void> { await this.call("close", { threadId }); }
  review(text: string, cwd: string, model?: string): Promise<string> { return this.call("review", { text, cwd, model }); }
  snapshot(threadId: string): unknown {
    return this.known(threadId) ? JSON.parse(readFileSync(join(this.home, "sessions", `${threadId}.json`), "utf8")) : undefined;
  }
}
