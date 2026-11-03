import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
    this.child = spawn(bin, args, { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
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
    if (!child.pid) { this.child = undefined; return; }
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const waitExit = (ms: number): Promise<boolean> => {
      if (exited()) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); child.off("exit", finish); resolve(true); };
        const timer = setTimeout(() => { child.off("exit", finish); resolve(exited()); }, ms);
        child.once("exit", finish);
      });
    };
    const activeMembers = (): boolean => {
      // A reparented zombie has no executable work left and cannot be killed again.
      const rows = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024 });
      return rows.split("\n").some((line) => { const [group, status] = line.trim().split(/\s+/); return Number(group) === child.pid && status && !status.startsWith("Z"); });
    };
    const groupAlive = (): boolean => {
      if (process.platform === "win32") return !exited();
      if (!activeMembers()) return false;
      try { process.kill(-child.pid!, 0); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ESRCH" || (code === "EPERM" && !activeMembers())) return false;
        throw e; // A permission failure for active work is still unconfirmed shutdown.
      }
      return true;
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid!, signal); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && !(process.platform !== "win32" && code === "EPERM" && !activeMembers())) throw e;
      }
    };
    const waitGroup = async (ms: number) => {
      const until = Date.now() + ms;
      while (groupAlive()) { if (Date.now() >= until) return false; await new Promise((resolve) => setTimeout(resolve, 25)); }
      return true;
    };
    if (!child.stdin.destroyed) child.stdin.end();
    await waitExit(1500);
    if (groupAlive()) {
      signalGroup("SIGTERM");
      if (!await waitGroup(1000)) {
        signalGroup("SIGKILL"); // Only the isolated process group this client spawned.
        if (!await waitGroup(1000)) throw new Error("owned Codex process group did not exit; ownership retained");
      }
    }
    if (!await waitExit(1000)) throw new Error("owned Codex app-server exit is unconfirmed; ownership retained");
    this.child = undefined;
  }
}
