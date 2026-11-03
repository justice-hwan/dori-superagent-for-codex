import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import type { AgentStatus, SessionRuntime } from "../src/sessions.ts";
import type { Exec } from "../src/process.ts";
import { Store, type HostLoad } from "../src/store.ts";

type Thread = { status: AgentStatus; received: string[] };
export class World {
  threads = new Map<string, Thread>();
  calls: { cmd: string; argv: readonly string[] }[] = [];
  clock = 1_000_000;
  host: HostLoad = { load1: 1, cores: 8, memFreePct: 50 };
  next = 1;
  promptFails = new Map<string, string>();
  gh: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 1, stdout: "" });
  reviewer: (argv: readonly string[]) => { code: number; stdout: string } = () => ({ code: 0, stdout: "VERDICT: CLEAR" });
  addThread(id: string, status: AgentStatus = "idle"): Thread {
    const t = { status, received: [] as string[] }; this.threads.set(id, t); return t;
  }
  exec: Exec = async (cmd, argv) => {
    this.calls.push({ cmd, argv });
    if (cmd === "gh") return { ...this.gh(argv), stderr: "" };
    const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
    const [method, id, text] = argv;
    if (method === "create") { const id = `w1:p${++this.next}`; this.addThread(id); return ok(id); }
    const t = this.threads.get(id!);
    if (method === "status") return ok(t?.status ?? "gone");
    if (!t) return { code: 1, stdout: "", stderr: "thread not found" };
    if (method === "deliver") {
      const fail = this.promptFails.get(id!);
      if (fail) return { code: 1, stdout: "", stderr: fail };
      t.received.push(text!); return ok(null);
    }
    if (method === "close") { this.threads.delete(id!); return ok(null); }
    if (method === "read") return ok(t.received.at(-1) ?? "");
    return { code: 1, stdout: "", stderr: `unhandled ${method}` };
  };
  deps(): Deps {
    const call = async <T>(method: string, args: string[]): Promise<T> => {
      const r = await this.exec("sessions", [method, ...args]);
      if (r.code) throw new Error(`sessions ${method}: ${r.stderr}`);
      return JSON.parse(r.stdout) as T;
    };
    const sessions: SessionRuntime = {
      known: (id) => this.threads.has(id),
      create: (name, cwd, instructions) => call("create", [name, cwd, instructions]),
      status: (id) => call("status", [id]),
      deliver: async (id, text) => { await call("deliver", [id, text]); },
      read: (id) => call("read", [id]),
      close: async (id) => { await call("close", [id]); },
      review: async (text, _cwd, model) => { const r = this.reviewer([text, model ?? "default"]); if (r.code) throw new Error("review failed"); return r.stdout; },
    };
    return { store: new Store(mkdtempSync(join(tmpdir(), "dori-test-"))), sessions, exec: this.exec, now: () => this.clock, doriCmd: "dori", host: () => this.host };
  }
}
