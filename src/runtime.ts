import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Codex, type RpcMessage } from "./codex.ts";
import { socketPath, validThread, type AgentStatus } from "./sessions.ts";
import { acquireFileLease } from "./lock.ts";

export type Session = { id: string; name: string; cwd: string; instructions: string; status: AgentStatus; model?: string; readOnly?: boolean; everStarted?: boolean; uncertainDelivery?: boolean; pendingDeliveryId?: string; lastDeliveryId?: string; turnId?: string; lastTurnStatus?: string; output: string; closed?: boolean };
export type Request = { id: number | string; method: string; params: any };

export class Runtime {
  readonly sessions = new Map<string, Session>();
  readonly requests = new Map<string, Request>();
  private loaded = new Set<string>();
  private resuming = new Map<string, Promise<void>>();
  private revisions = new Map<string, number>();
  private busy = new Set<string>();
  private closing = new Set<string>();
  private interrupting = new Set<string>();
  private submitting = new Set<string>();
  private finished = new Set<string>();
  stopping = false;

  constructor(readonly home: string, readonly codex = new Codex()) {
    mkdirSync(join(home, "sessions"), { recursive: true, mode: 0o700 });
    for (const f of readdirSync(join(home, "sessions"))) {
      if (!f.endsWith(".json")) continue;
      const s = JSON.parse(readFileSync(join(home, "sessions", f), "utf8")) as Session;
      if (!validThread(s.id) || f !== `${s.id}.json`) throw new Error("invalid saved session id");
      this.sessions.set(s.id, s);
    }
    this.codex.onMessage = (m) => this.message(m);
    this.codex.onExit = () => {
      this.loaded.clear();
      for (const s of this.sessions.values()) {
        if (!s.closed) { s.status = "unknown"; this.save(s); }
      }
      this.requests.clear(); this.saveRequests();
    };
  }

  private save(s: Session): void {
    const path = join(this.home, "sessions", `${s.id}.json`);
    writeFileSync(path + ".tmp", JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  private saveRequests(): void {
    writeFileSync(join(this.home, "requests.json"), JSON.stringify([...this.requests.values()], null, 2) + "\n", { mode: 0o600 });
  }
  private owned(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.closed) throw new Error("thread is not an open Dori-owned session");
    return s;
  }

  async create(name: string, cwd: string, instructions: string, model?: string, readOnly = false): Promise<string> {
    if (this.stopping) throw new Error("runtime is stopping");
    const r = await this.codex.request("thread/start", {
      cwd: resolve(cwd), developerInstructions: instructions,
      approvalPolicy: "on-request", sandbox: readOnly ? "read-only" : "workspace-write", ...(model ? { model } : {}),
    });
    const id = r.thread?.id;
    if (typeof id !== "string" || !validThread(id)) throw new Error("Codex returned no valid thread id");
    const s: Session = { id, name, cwd: resolve(cwd), instructions, status: "idle", output: "", model, readOnly };
    this.sessions.set(id, s); this.loaded.add(id); this.save(s);
    return id;
  }

  private async resume(s: Session): Promise<void> {
    if (this.loaded.has(s.id)) return;
    const pending = this.resuming.get(s.id);
    if (pending) return pending;
    const work = this.resumeOnce(s);
    this.resuming.set(s.id, work);
    try { await work; } finally { if (this.resuming.get(s.id) === work) this.resuming.delete(s.id); }
  }

  private async resumeOnce(s: Session): Promise<void> {
    const revision = this.revisions.get(s.id) ?? 0;
    let r: any;
    try {
      r = await this.codex.request("thread/resume", {
        threadId: s.id, cwd: s.cwd, developerInstructions: s.instructions,
        approvalPolicy: "on-request", sandbox: s.readOnly ? "read-only" : "workspace-write", excludeTurns: true,
      });
    } catch (e) {
      // Codex does not persist an empty thread's rollout before its first turn.
      // Only a provably unused thread may be replaced. Never discard an uncertain delivery.
      if (!s.everStarted && !s.turnId && !s.lastTurnStatus && !s.output && /no rollout found|thread not found/i.test(String(e))) {
        s.closed = true; s.status = "gone"; this.save(s); return;
      }
      throw e;
    }
    const status = r.thread?.status;
    // A resume never starts a model turn. Unknown server states remain unsendable.
    if ((this.revisions.get(s.id) ?? 0) === revision) {
      s.status = s.uncertainDelivery ? "unknown" : status?.type === "active" ? "working" : status?.type === "idle" ? "idle" : "unknown";
    }
    this.loaded.add(s.id); this.save(s);
  }

  async status(id: string): Promise<AgentStatus> {
    const s = this.sessions.get(id);
    if (!s || s.closed) return "gone";
    await this.resume(s);
    return s.status;
  }

  async deliver(id: string, text: string, deliveryId?: string): Promise<void> {
    if (this.stopping) throw new Error("runtime is stopping");
    if (!text.trim()) throw new Error("message must not be empty");
    const s = this.owned(id);
    if (deliveryId && s.lastDeliveryId === deliveryId) return;
    if (this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread is closing or being interrupted; message not submitted");
    if (this.busy.has(id)) throw new Error("thread delivery already in progress");
    this.busy.add(id);
    try {
      await this.resume(s);
      if (s.status !== "idle" && s.status !== "done" && s.status !== "failed") throw new Error(`thread is ${s.status}; message not submitted`);
      s.status = "working"; s.output = ""; s.lastTurnStatus = undefined; s.everStarted = true; s.pendingDeliveryId = deliveryId;
      // Write-ahead uncertainty closes the crash window before the external submission.
      s.uncertainDelivery = true; this.save(s);
      this.submitting.add(id);
      try {
        const r = await this.codex.request("turn/start", { threadId: id, input: [{ type: "text", text, text_elements: [] }], ...(deliveryId ? { clientUserMessageId: deliveryId } : {}) });
        if (typeof r.turn?.id !== "string") throw new Error("Codex returned no turn id");
        if (!this.finished.has(r.turn.id)) s.turnId = r.turn.id;
        s.lastDeliveryId = deliveryId; s.uncertainDelivery = false;
        this.save(s);
      } catch (e) {
        // A timeout does not prove no turn started. Don't automatically replay the input.
        if (deliveryId && s.lastDeliveryId === deliveryId) return;
        s.status = "unknown"; s.uncertainDelivery = true; this.save(s); throw e;
      } finally { this.submitting.delete(id); }
    } finally { this.busy.delete(id); }
  }

  private message(m: RpcMessage): void {
    const p = m.params ?? {};
    const s = this.sessions.get(p.threadId ?? p.thread?.id);
    if (m.id !== undefined && m.method) {
      if (!s || s.closed) {
        this.codex.write({ id: m.id, error: { code: -32601, message: "Dori does not own this request's thread" } });
        return;
      }
      this.requests.set(String(m.id), { id: m.id, method: m.method, params: p });
      this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
      s.status = "blocked"; this.save(s); this.saveRequests();
      return;
    }
    if (m.method === "serverRequest/resolved") {
      this.requests.delete(String(p.requestId)); this.saveRequests();
    }
    if (!s || s.closed) return;
    if (m.method === "turn/started") {
      this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
      if (this.submitting.has(s.id)) { s.lastDeliveryId = s.pendingDeliveryId; s.uncertainDelivery = false; }
      s.status = s.uncertainDelivery ? "unknown" : "working"; s.turnId = p.turn?.id;
    }
    else if (m.method === "item/agentMessage/delta") s.output += p.delta ?? "";
    else if (m.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string") {
      // The final item is authoritative; it also works with servers that omit streaming deltas.
      if (p.item.phase !== "commentary") s.output = p.item.text;
    } else if (m.method === "turn/completed") {
      this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
      const turn = p.turn;
      if (typeof turn?.id === "string") this.finished.add(turn.id);
      s.lastTurnStatus = turn?.status;
      s.status = s.uncertainDelivery ? "unknown" : turn?.status === "completed" ? "done" : turn?.status === "interrupted" ? "idle" : turn?.status === "failed" ? "failed" : "unknown";
      s.turnId = undefined;
      for (const [id, request] of this.requests) if (request.params.threadId === s.id) this.requests.delete(id);
      this.saveRequests();
    } else return;
    this.save(s);
  }

  async reconcile(id: string, delivered: boolean): Promise<void> {
    const s = this.owned(id);
    if (!s.uncertainDelivery) throw new Error("thread has no uncertain delivery");
    const revision = this.revisions.get(id) ?? 0;
    const r = await this.codex.request("thread/read", { threadId: id, includeTurns: false });
    if ((this.revisions.get(id) ?? 0) !== revision) throw new Error("thread state changed during reconciliation; inspect it again");
    if (r.thread?.status?.type !== "idle") throw new Error("thread must be idle before reconciling delivery");
    if (delivered) s.lastDeliveryId = s.pendingDeliveryId;
    s.pendingDeliveryId = undefined; s.uncertainDelivery = false; s.status = "idle"; this.save(s);
  }

  async answer(id: string, result: unknown): Promise<void> {
    const request = this.requests.get(id);
    if (!request) throw new Error("request is no longer pending; refresh requests before answering");
    this.codex.write({ id: request.id, result });
    this.requests.delete(id); this.saveRequests();
    const s = this.owned(request.params.threadId);
    s.status = "working"; this.save(s);
  }

  async interrupt(id: string): Promise<void> {
    const s = this.owned(id);
    if (this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread shutdown operation already in progress");
    this.interrupting.add(id);
    try {
      const deadline = Date.now() + 25_000;
      while (this.busy.has(id)) {
        if (Date.now() >= deadline) throw new Error("submission still pending; interruption unconfirmed");
        await Bun.sleep(10);
      }
      await this.resume(s);
      const turnId = s.turnId;
      if (!turnId) {
        if (s.uncertainDelivery || ["working", "blocked", "unknown"].includes(s.status)) throw new Error("active turn identity is unresolved; interruption unconfirmed");
        return;
      }
      try { await this.codex.request("turn/interrupt", { threadId: id, turnId }); }
      catch (e) { if (!this.finished.has(turnId)) throw e; }
      const until = Date.now() + 5000;
      while (!this.finished.has(turnId) && s.turnId === turnId) {
        if (Date.now() >= until) throw new Error("interrupt acknowledged but completion is unconfirmed");
        await Bun.sleep(10);
      }
    } finally { this.interrupting.delete(id); }
  }

  async close(id: string): Promise<void> {
    const s = this.owned(id);
    if (this.busy.has(id) || this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread operation already in progress; finish it before closing");
    this.closing.add(id);
    try {
      if (["working", "blocked", "unknown"].includes(await this.status(id))) throw new Error("finish or interrupt the turn before closing");
      await this.codex.request("thread/archive", { threadId: id });
      s.closed = true; s.status = "gone"; this.save(s);
    } finally { this.closing.delete(id); }
  }

  async review(text: string, cwd: string, model?: string): Promise<string> {
    const id = await this.create("review", cwd, "Review only. Never modify, push or merge anything. Finish with VERDICT: CLEAR or VERDICT: BLOCK.", model, true);
    try {
      await this.deliver(id, text);
      const deadline = Date.now() + 1_200_000;
      while (Date.now() < deadline) {
        const s = this.owned(id);
        if (s.status === "done") return s.output;
        if (s.status === "blocked") throw new Error(`review needs a response: dori-codex requests (thread ${id})`);
        if (s.status === "unknown" || s.status === "failed") throw new Error("review failed or disconnected; no receipt written");
        await Bun.sleep(100);
      }
      await this.interrupt(id); throw new Error("review timed out; no receipt written");
    } finally {
      if (["done", "idle", "failed"].includes(this.sessions.get(id)?.status ?? "")) await this.close(id);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.sessions.values()].filter((s) => !s.closed && s.turnId).map((s) => this.interrupt(s.id)));
    await this.codex.disconnect();
  }
}

export async function serve(home: string, onTick: () => Promise<void> = async () => {}): Promise<never> {
  process.umask(0o077);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, "runtime.lock");
  const lease = acquireFileLease(lock);
  if (!lease) throw new Error("Dori runtime lock or claim gate is held; inspect it before starting another runtime");
  const path = socketPath(home);
  let runtime: Runtime | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  let cleanupPromise: Promise<void> | undefined;
  let shutdownError: string | undefined;
  let socketOwned = false;
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      stopping = true; if (timer) clearInterval(timer);
      await runtime?.shutdown();
      server?.stop(true);
      if (socketOwned && lease.holds() && existsSync(path)) unlinkSync(path);
      lease.release();
    })().catch((e) => { shutdownError = e instanceof Error ? e.message : String(e); cleanupPromise = undefined; throw e; });
    return cleanupPromise;
  };
  const stopAndExit = () => { void cleanup().then(() => process.exit(0)).catch((e) => console.error("shutdown unconfirmed:", e.message)); };
  try {
    if (existsSync(path)) {
      const st = lstatSync(path);
      if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error("refusing to replace an unowned runtime socket");
      unlinkSync(path);
    }
    runtime = new Runtime(home);
    await runtime.codex.connect();
    if (!lease.holds()) throw new Error("runtime ownership changed during startup");
    server = Bun.serve({ unix: path, maxRequestBodySize: 1_048_576, async fetch(req, server) {
      try {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/rpc") return new Response("not found", { status: 404 });
        const { method, args: a = {} } = await req.json() as { method: string; args: any };
        server.timeout(req, 0); // RPC operations and the client own explicit deadlines, including slow submissions.
        if (runtime!.stopping && method !== "health" && method !== "shutdown") throw new Error("runtime is stopping");
        let value: unknown;
        switch (method) {
          case "health": value = { pid: process.pid, sessions: runtime!.sessions.size, stopping, shutdownError }; break;
          case "create": value = await runtime!.create(a.name, a.cwd, a.instructions, a.model, a.readOnly === true); break;
          case "status": value = await runtime!.status(a.threadId); break;
          case "deliver": value = await runtime!.deliver(a.threadId, a.text, a.deliveryId); break;
          case "read": value = runtime!.sessions.get(a.threadId)?.output ?? ""; break;
          case "interrupt": value = await runtime!.interrupt(a.threadId); break;
          case "reconcile": if (typeof a.delivered !== "boolean") throw new Error("delivered must be a boolean"); value = await runtime!.reconcile(a.threadId, a.delivered); break;
          case "close": value = await runtime!.close(a.threadId); break;
          case "review": value = await runtime!.review(a.text, a.cwd, a.model); break;
          case "requests": value = [...runtime!.requests.values()]; break;
          case "answer": value = await runtime!.answer(a.id, a.result); break;
          case "account": { const r = await runtime!.codex.request("account/read", { refreshToken: false }); value = { signedIn: r.account != null, authMode: r.account?.type ?? null }; break; }
          case "shutdown": setTimeout(stopAndExit, 50); value = "stopping"; break;
          default: throw new Error("unknown runtime method");
        }
        return Response.json({ value: value ?? null });
      } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
    } });
    socketOwned = true;
    chmodSync(path, 0o600);
    let ticking = false;
    timer = setInterval(() => {
      if (ticking || stopping) return;
      ticking = true;
      void onTick().catch((e) => console.error("duty tick failed:", e.message)).finally(() => { ticking = false; });
    }, 60_000);
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, stopAndExit);
    await new Promise<never>(() => {});
  } finally { await cleanup(); }
  throw new Error("runtime stopped");
}
