import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** One documented, newline-delimited Codex app-server connection. No network collector is part of this client. */
export class Codex {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: () => void = () => {};

  constructor(private readonly argv: readonly string[] = [process.env["DORI_CODEX_BIN"] ?? "codex", "app-server", "--listen", "stdio://"]) {}

  async connect(): Promise<void> {
    if (this.child) throw new Error("Codex connection already opened");
    const [bin, ...args] = this.argv;
    if (!bin) throw new Error("missing Codex executable");
    this.child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    // stderr is drained, but may contain local paths or MCP errors: don't copy it into public responses.
    this.child.stderr.resume();
    const fail = (error: Error) => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      this.pending.clear();
    };
    this.child.on("error", fail);
    this.child.on("exit", () => { fail(new Error("Codex app-server disconnected")); this.onExit(); });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.method && typeof message.id === "number" && this.pending.has(message.id)) {
        const p = this.pending.get(message.id)!;
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(new Error(`Codex RPC ${message.error.code}: ${message.error.message}`));
        else p.resolve(message.result);
      } else this.onMessage(message);
    });
    await this.request("initialize", { clientInfo: { name: "dori_superagent_for_codex", title: "Dori for Codex", version: "0.2.0" } });
    this.write({ method: "initialized", params: {} });
  }

  request(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}; inspect state before retrying`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  write(message: RpcMessage): void {
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async disconnect(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { this.child = undefined; return; }
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 1500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    this.child = undefined;
  }
}
