import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { type Connection, OWNED, unixPath } from "./connection.ts";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Expose only known classifications, never the server's arbitrary error payload. */
export class CodexRpcError extends Error {
  readonly missingThread: boolean;
  readonly turnRace: boolean;
  constructor(readonly code: number, raw: string) {
    const missing = /no rollout found|thread not found/i.test(raw);
    const race = [-32600, -32602, -32000].includes(code) && /^(?:no active turn(?: to (?:steer|interrupt))?[.!]?|(?:expected(?: active)? turn(?: id)?|expectedTurnId)\b[^\n]*(?:mismatch|does not match)[^\n]*|already (?:has an )?active turn[.!]?)$/i.test(raw);
    super(missing ? "Codex RPC: no rollout found for thread" : race ? "Codex RPC: turn precondition rejected" : `Codex RPC rejected (${Number.isInteger(code) ? code : "unknown"})`);
    this.missingThread = missing; this.turnRace = race;
  }
}

/** Owned newline-delimited stdio or a shared local Unix WebSocket; no remote collector. */
export class Codex {
  private child?: ChildProcessWithoutNullStreams;
  private websocket?: Bun.WebSocket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  onMessage: (message: RpcMessage) => void = () => {};
  onExit: () => void = () => {};

  constructor(private readonly source: readonly string[] | Connection = [process.env["DORI_CODEX_BIN"] ?? "codex", "app-server", "--listen", "stdio://"], private readonly timeoutMs = 30_000) {}

  get connection(): Connection { return Array.isArray(this.source) ? OWNED : this.source as Connection; }
  get shared(): boolean { return this.connection.mode === "shared"; }
  get connected(): boolean { return this.shared ? this.websocket?.readyState === WebSocket.OPEN : !!this.child && this.child.exitCode === null; }

  private fail(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (!message.method && typeof message.id === "number" && this.pending.has(message.id)) {
      const p = this.pending.get(message.id)!;
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (message.error) p.reject(new CodexRpcError(message.error.code, typeof message.error.message === "string" ? message.error.message : ""));
      else p.resolve(message.result);
    } else this.onMessage(message);
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "dori_superagent_for_codex", title: "Dori for Codex", version: "0.2.0" } });
    this.write({ method: "initialized", params: {} });
  }

  async connect(): Promise<void> {
    const c = this.connection;
    if (c.mode === "shared") {
      if (this.connecting) return this.connecting;
      if (this.connected) return;
      unixPath(c.endpoint);
      const ws = this.websocket = new WebSocket(c.endpoint) as unknown as Bun.WebSocket;
      let exited = false;
      const lost = () => {
        if (this.websocket !== ws || exited) return;
        exited = true; this.fail(new Error("Codex app-server disconnected")); this.onExit();
      };
      ws.addEventListener("message", event => { if (this.websocket === ws) this.receive(String(event.data)); });
      ws.addEventListener("close", lost);
      ws.addEventListener("error", () => { lost(); ws.terminate(); });
      const work = (async () => {
        try {
          await new Promise<void>((resolve, reject) => {
            const done = (error?: Error) => { clearTimeout(timer); ws.removeEventListener("open", opened); ws.removeEventListener("error", failed); ws.removeEventListener("close", failed); if (error) reject(error); else resolve(); };
            const opened = () => done();
            const failed = () => done(new Error("shared Codex connection failed"));
            const timer = setTimeout(() => done(new Error("shared Codex connection timeout")), Math.min(this.timeoutMs, 10_000));
            ws.addEventListener("open", opened, { once: true }); ws.addEventListener("error", failed, { once: true }); ws.addEventListener("close", failed, { once: true });
          });
          await this.initialize();
        } catch (e) { lost(); ws.terminate(); throw e; }
      })();
      this.connecting = work;
      try { await work; } finally { if (this.connecting === work) this.connecting = undefined; }
      return;
    }
    if (this.child) throw new Error("Codex connection already opened");
    const [bin, ...args] = Array.isArray(this.source) ? this.source : [process.env["DORI_CODEX_BIN"] ?? "codex", "app-server", "--listen", "stdio://"];
    if (!bin) throw new Error("missing Codex executable");
    this.child = spawn(bin, args, { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    // stderr is drained, but may contain local paths or MCP errors: don't copy it into public responses.
    this.child.stderr.resume();
    const fail = (error: Error) => this.fail(error);
    this.child.on("error", fail);
    this.child.on("exit", () => { fail(new Error("Codex app-server disconnected")); this.onExit(); });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    await this.initialize();
  }

  request(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex RPC timeout: ${method}; inspect state before retrying`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  write(message: RpcMessage): void {
    if (this.shared) {
      if (!this.connected) throw new Error("Codex app-server is not connected");
      try { this.websocket!.send(JSON.stringify(message)); } catch { throw new Error("shared Codex send failed; delivery may be uncertain"); }
      return;
    }
    if (!this.child || this.child.stdin.destroyed) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async disconnect(): Promise<void> {
    if (this.shared) {
      this.fail(new Error("Codex app-server disconnected"));
      // terminate closes only this client socket and bounds cleanup even if the peer never replies.
      const ws = this.websocket; this.websocket = undefined; ws?.terminate(); this.onExit();
      return;
    }
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
