import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Codex, CodexRpcError, type RpcMessage } from "./codex.ts";
import { readConnection } from "./connection.ts";
import { socketPath, validThread, DeliveryDeferred, type AgentStatus } from "./sessions.ts";
import { acquireFileLease } from "./lock.ts";
import { stateHome } from "./paths.ts";

type AcceptedDelivery = { turnId: string; clientId: string; created?: boolean };
export type Session = { id: string; name: string; cwd: string; instructions: string; status: AgentStatus; externalLead?: boolean; ownedTurnId?: string; pendingOwnership?: { turnId: string; clientId: string }; acceptedDelivery?: AcceptedDelivery; model?: string; readOnly?: boolean; everStarted?: boolean; uncertainDelivery?: boolean; requiresRecovery?: boolean; pendingDeliveryId?: string; lastDeliveryId?: string; turnId?: string; lastTurnId?: string; lastTurnStatus?: string; output: string; closed?: boolean };
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
  private creating = 0;
  private deferredRequests = new Map<string, Request>();
  stopping = false;

  constructor(readonly home: string, readonly codex = new Codex(), private readonly reviewTimeoutMs = 1_200_000, private readonly interruptTimeoutMs = 5000) {
    this.home = stateHome(home);
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
      this.requests.clear(); this.deferredRequests.clear(); this.saveRequests();
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
    if (!s || s.closed || this.isExternalLead(id)) throw new Error("thread is not an open Dori-owned session (external lead is protected)");
    return s;
  }

  isExternalLead(id: string): boolean {
    const c = this.codex.connection;
    return this.sessions.get(id)?.externalLead === true || (c.mode === "shared" && c.lead === id);
  }

  private async ensureConnection(): Promise<void> { if (this.codex.shared) await this.codex.connect(); }

  private idleStatus(s: Session): AgentStatus {
    if (s.uncertainDelivery) return "unknown";
    // Native idle is admission readiness for the external lead, independent of its past result.
    if (this.isExternalLead(s.id)) return "idle";
    return s.requiresRecovery ? "recovery" : s.lastTurnStatus === "failed" ? "failed" : s.lastTurnStatus === "completed" ? "done" : "idle";
  }

  private terminal(s: Session, turn: any): boolean {
    if (typeof turn?.id !== "string" || !["completed", "failed", "interrupted"].includes(turn.status)) return false;
    s.lastTurnId = turn.id; s.lastTurnStatus = turn.status; s.requiresRecovery = false;
    if (s.ownedTurnId === turn.id) s.ownedTurnId = undefined;
    if (s.pendingOwnership?.turnId === turn.id) s.pendingOwnership = undefined;
    return true;
  }

  /** A turn/start response can instead be a steer. Its first user message proves who created it. */
  private async proveOwnership(s: Session): Promise<void> {
    const accepted = s.acceptedDelivery;
    const pending = s.pendingOwnership ?? (accepted?.created === undefined ? accepted : undefined);
    if (!pending) return;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const r = await this.codex.request("thread/items/list", { threadId: s.id, turnId: pending.turnId, sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) });
        if (s.acceptedDelivery !== accepted || (!accepted && s.pendingOwnership !== pending)) return;
        if (!Array.isArray(r.data) || r.data.some((entry: any) => entry.turnId !== pending.turnId || !entry.item)) return;
        const first = r.data.find((entry: any) => entry.item.type === "userMessage")?.item;
        if (first) {
          if (typeof first.clientId !== "string" || !first.clientId) return;
          if (accepted?.turnId === pending.turnId && accepted.clientId === pending.clientId) accepted.created = first.clientId === pending.clientId;
          if (first.clientId === pending.clientId && !this.finished.has(pending.turnId) && !(s.lastTurnId === pending.turnId && ["completed", "failed", "interrupted"].includes(s.lastTurnStatus ?? ""))) s.ownedTurnId = pending.turnId;
          // A different first clientId proves native creation, even if our later input was accepted.
          if (s.pendingOwnership?.turnId === pending.turnId && s.pendingOwnership.clientId === pending.clientId) s.pendingOwnership = undefined;
          this.save(s); this.admitDeferredRequests(s); return;
        }
        if (typeof r.nextCursor !== "string" || !r.nextCursor || r.nextCursor === cursor) return;
        cursor = r.nextCursor;
      }
    } catch { /* Accepted delivery and uncertain creation are separate; cleanup stays conservative. */ }
  }

  private async historyTurn(id: string, turnId: string, deadline = Date.now() + 30_000): Promise<any> {
    let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      if (Date.now() >= deadline) throw new Error("exact turn lookup timed out");
      const r = await this.codex.request("thread/turns/list", { threadId: id, sortDirection: "desc", limit: 100, itemsView: "notLoaded", ...(cursor ? { cursor } : {}) }, Math.min(30_000, deadline - Date.now()));
      const exact = r.data?.find((t: any) => t.id === turnId);
      if (exact) return exact;
      if (typeof r.nextCursor !== "string" || !r.nextCursor || r.nextCursor === cursor) return;
      cursor = r.nextCursor;
    }
    throw new Error("exact turn history is incomplete");
  }

  private async turnItems(id: string, turnId: string, deadline: number): Promise<any[]> {
    const items: any[] = []; let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      if (Date.now() >= deadline) throw new Error("exact turn output lookup timed out");
      const r = await this.codex.request("thread/items/list", { threadId: id, turnId, sortDirection: "asc", limit: 100, ...(cursor ? { cursor } : {}) }, Math.min(30_000, deadline - Date.now()));
      if (!Array.isArray(r.data) || r.data.some((entry: any) => entry.turnId !== turnId || !entry.item)) throw new Error("exact turn output identity is unconfirmed");
      items.push(...r.data.map((entry: any) => entry.item));
      if (r.nextCursor === null) return items;
      if (typeof r.nextCursor !== "string" || !r.nextCursor || r.nextCursor === cursor) throw new Error("exact turn output pagination is unconfirmed");
      cursor = r.nextCursor;
    }
    throw new Error("exact turn output is incomplete");
  }

  private admitDeferredRequests(s: Session): void {
    for (const [id, request] of this.deferredRequests) {
      if (request.params.threadId !== s.id) continue;
      if (request.params.turnId === s.ownedTurnId) {
        this.requests.set(id, request); s.status = "blocked";
      } else if (s.pendingOwnership || this.submitting.has(s.id)) continue;
      this.deferredRequests.delete(id);
    }
    this.save(s); this.saveRequests();
  }

  /** Registration first proves native ownership/load state without resuming or changing policy. */
  async registerExternalLead(id: string): Promise<void> {
    const c = this.codex.connection;
    if (c.mode !== "shared" || c.lead !== id) throw new Error("external lead must match the selected shared connection");
    const existing = this.sessions.get(id);
    if (existing && !existing.externalLead) throw new Error("cannot replace an owned session with an external lead");
    if ([...this.sessions.values()].some(s => s.externalLead && s.id !== id)) throw new Error("external lead already registered; replacement refused");
    await this.ensureConnection();
    const r = await this.codex.request("thread/read", { threadId: id, includeTurns: false });
    if (r.thread?.id !== id || !["active", "idle"].includes(r.thread?.status?.type)) throw new Error("external lead must already be loaded and idle or active on this server");
    const s: Session = existing ?? { id, name: r.thread.name ?? "external lead", cwd: "", instructions: "", externalLead: true, status: "unknown", output: "" };
    this.sessions.set(id, s); this.save(s);
    await this.refreshShared(s);
  }

  private async refreshShared(s: Session): Promise<void> {
    await this.ensureConnection();
    if (s.pendingOwnership || s.acceptedDelivery?.created === undefined) await this.proveOwnership(s);
    if (!this.loaded.has(s.id)) {
      if (this.isExternalLead(s.id)) {
        const r = await this.codex.request("thread/resume", { threadId: s.id, excludeTurns: true });
        if (r.thread?.id !== s.id) throw new Error("Codex returned a different resumed thread");
        this.loaded.add(s.id);
      } else await this.resume(s);
    }
    // Always read native status, including after UI-started turns. Local notification caches are insufficient.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = this.revisions.get(s.id) ?? 0;
      const r = await this.codex.request("thread/read", { threadId: s.id, includeTurns: false });
      if (r.thread?.id !== s.id) throw new Error("Codex returned a different thread");
      const status = r.thread.status;
      if (status?.type === "notLoaded") {
        this.loaded.delete(s.id);
        if (this.isExternalLead(s.id)) {
          const joined = await this.codex.request("thread/resume", { threadId: s.id, excludeTurns: true });
          if (joined.thread?.id !== s.id) throw new Error("Codex returned a different resumed thread");
          this.loaded.add(s.id);
        } else await this.resume(s);
        continue;
      }
      let turn: any;
      if (status?.type === "active") {
        turn = (await this.codex.request("thread/turns/list", { threadId: s.id, sortDirection: "desc", limit: 1, itemsView: "notLoaded" })).data?.[0];
        const current = await this.codex.request("thread/read", { threadId: s.id, includeTurns: false });
        if (current.thread?.id !== s.id || current.thread?.status?.type !== "active" || (this.revisions.get(s.id) ?? 0) !== revision) continue;
        status.activeFlags = current.thread.status.activeFlags;
        if (s.ownedTurnId && s.ownedTurnId !== turn?.id) {
          const exact = await this.historyTurn(s.id, s.ownedTurnId);
          if (exact) this.terminal(s, exact);
          if ((this.revisions.get(s.id) ?? 0) !== revision) continue;
        }
      } else {
        if (status?.type === "idle" && !this.isExternalLead(s.id) && s.everStarted) {
          const expected = s.ownedTurnId ?? s.pendingOwnership?.turnId ?? s.acceptedDelivery?.turnId ?? s.lastTurnId ?? s.turnId;
          turn = expected ? await this.historyTurn(s.id, expected) : (await this.codex.request("thread/turns/list", { threadId: s.id, sortDirection: "desc", limit: 1, itemsView: "notLoaded" })).data?.[0];
          const confirmed = typeof turn?.id === "string" && (!expected || turn.id === expected) && ["completed", "interrupted", "failed"].includes(turn.status);
          s.requiresRecovery = !confirmed;
          if (confirmed) this.terminal(s, turn);
        }
        if ((this.revisions.get(s.id) ?? 0) !== revision) continue;
      }
      s.turnId = status?.type === "active" && typeof turn?.id === "string" && turn.status === "inProgress" ? turn.id : undefined;
      const blocked = status?.type === "active" && (!Array.isArray(status.activeFlags) || status.activeFlags.length > 0);
      s.status = s.uncertainDelivery ? "unknown" : status?.type === "idle" ? this.idleStatus(s) : blocked ? "blocked" : s.turnId ? "working" : "unknown";
      this.save(s); return;
    }
    s.status = "unknown"; this.save(s);
    throw new Error("native thread changed during refresh; delivery deferred");
  }

  private policy(cwd: string, readOnly = false): Record<string, unknown> {
    if (readOnly) return { sandbox: "read-only", config: { project_doc_max_bytes: 0, projects: { [stateHome(cwd)]: { trust_level: "untrusted" } } } };
    const socket = socketPath(this.home);
    const canonicalSocket = join(stateHome(dirname(socket)), basename(socket));
    const unixSockets = Object.fromEntries([...new Set([socket, canonicalSocket])].map(path => [path, "allow"]));
    return { config: {
      default_permissions: "dori_codex",
      permissions: { dori_codex: { extends: ":workspace", filesystem: { [this.home]: "write" }, network: { enabled: true, domains: {}, unix_sockets: unixSockets } } },
      features: { network_proxy: { enabled: true, domains: {}, proxy_url: "http://127.0.0.1:0", enable_socks5: false } },
    } };
  }

  async create(name: string, cwd: string, instructions: string, model?: string, readOnly = false): Promise<string> {
    if (this.stopping) throw new Error("runtime is stopping");
    this.creating++;
    try {
    cwd = stateHome(cwd);
    await this.ensureConnection();
    if (this.stopping) throw new Error("runtime is stopping; thread not created");
    const r = await this.codex.request("thread/start", {
      cwd, developerInstructions: instructions,
      approvalPolicy: "on-request", ...this.policy(cwd, readOnly), ...(model ? { model } : {}),
    });
    const id = r.thread?.id;
    if (typeof id !== "string" || !validThread(id)) throw new Error("Codex returned no valid thread id");
    if (this.isExternalLead(id) || this.sessions.has(id)) throw new Error("Codex returned an existing or protected thread; ownership refused");
    const s: Session = { id, name, cwd, instructions, status: "idle", output: "", model, readOnly };
    this.sessions.set(id, s); this.loaded.add(id); this.save(s);
    try { await this.codex.request("thread/name/set", { threadId: id, name: `🐾dori/${name}` }); }
    catch { /* Older app-servers may not support titles. Ownership remains recorded. */ }
    return id;
    } finally { this.creating--; }
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
        threadId: s.id, cwd: stateHome(s.cwd), developerInstructions: s.instructions,
        approvalPolicy: "on-request", ...this.policy(s.cwd, s.readOnly), excludeTurns: true,
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
    let latest: any;
    if (status?.type === "idle" && s.everStarted) {
      try { latest = (await this.codex.request("thread/turns/list", { threadId: s.id, sortDirection: "desc", limit: 1, itemsView: "notLoaded" })).data?.[0]; }
      catch { /* An unavailable outcome requires recovery; idle alone does not certify completion. */ }
    }
    // A resume never starts a model turn. Unknown server states remain unsendable.
    if ((this.revisions.get(s.id) ?? 0) === revision) {
      if (status?.type === "idle" && s.everStarted) {
        const expected = s.turnId ?? s.lastTurnId;
        const confirmed = latest && typeof latest.id === "string" && (!expected || latest.id === expected) && ["completed", "interrupted", "failed"].includes(latest.status);
        s.requiresRecovery = !confirmed;
        if (confirmed) { s.lastTurnId = latest.id; s.lastTurnStatus = latest.status; }
        s.turnId = undefined;
      }
      s.status = s.uncertainDelivery ? "unknown" : status?.type === "active" ? "working" : status?.type === "idle" ? s.requiresRecovery ? "recovery" : s.lastTurnStatus === "failed" ? "failed" : s.lastTurnStatus === "completed" ? "done" : "idle" : "unknown";
    }
    this.loaded.add(s.id); this.save(s);
  }

  async status(id: string): Promise<AgentStatus> {
    const s = this.sessions.get(id);
    if (!s || s.closed) return "gone";
    if (this.codex.shared) await this.refreshShared(s); else await this.resume(s);
    return s.status;
  }

  async deliver(id: string, text: string, deliveryId?: string): Promise<void> {
    if (this.stopping) throw new Error("runtime is stopping");
    if (!text.trim()) throw new Error("message must not be empty");
    if (this.isExternalLead(id)) return this.deliverExternal(id, text, deliveryId);
    const s = this.owned(id);
    if (deliveryId && s.lastDeliveryId === deliveryId) return;
    if (this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread is closing or being interrupted; message not submitted");
    if (this.busy.has(id)) throw new Error("thread delivery already in progress");
    this.busy.add(id);
    try {
      if (this.codex.shared) await this.refreshShared(s); else await this.resume(s);
      if (this.stopping) throw new Error("runtime is stopping; message not submitted");
      if (s.status !== "idle" && s.status !== "done" && s.status !== "failed" && s.status !== "recovery") throw new Error(`thread is ${s.status}; message not submitted`);
      const clientId = deliveryId ?? (this.codex.shared ? randomUUID() : undefined);
      s.status = "working"; s.output = ""; s.lastTurnStatus = undefined; s.requiresRecovery = false; s.everStarted = true; s.pendingDeliveryId = clientId;
      // Write-ahead uncertainty closes the crash window before the external submission.
      s.uncertainDelivery = true; this.save(s);
      this.submitting.add(id);
      try {
        const r = await this.codex.request("turn/start", { threadId: id, input: [{ type: "text", text, text_elements: [] }], ...(clientId ? { clientUserMessageId: clientId } : {}) });
        if (typeof r.turn?.id !== "string") throw new Error("Codex returned no turn id");
        if (!this.finished.has(r.turn.id)) s.turnId = r.turn.id;
        if (this.codex.shared) {
          s.acceptedDelivery = { turnId: r.turn.id, clientId: clientId! };
          s.pendingOwnership = { turnId: r.turn.id, clientId: clientId! };
        }
        s.lastDeliveryId = clientId; s.uncertainDelivery = false;
        this.save(s);
        if (this.codex.shared) await this.proveOwnership(s);
        if (this.codex.shared && !this.finished.has(r.turn.id)) s.status = [...this.requests.values()].some(r => r.params.threadId === id) ? "blocked" : "working";
        else if (this.codex.shared && s.lastTurnId === r.turn.id) s.status = this.idleStatus(s);
        this.save(s);
      } catch (e) {
        // A timeout does not prove no turn started. Don't automatically replay the input.
        if (deliveryId && s.lastDeliveryId === deliveryId) return;
        s.status = "unknown"; s.uncertainDelivery = true; this.save(s); throw e;
      } finally { this.submitting.delete(id); if (this.codex.shared) this.admitDeferredRequests(s); }
    } finally { this.busy.delete(id); }
  }

  private async deliverExternal(id: string, text: string, deliveryId?: string): Promise<void> {
    const c = this.codex.connection;
    if (c.mode !== "shared" || c.lead !== id) throw new Error("external lead is not on the selected shared connection");
    const s = this.sessions.get(id);
    if (!s?.externalLead || s.closed) throw new Error("external lead is not registered");
    if (!deliveryId) throw new Error("external delivery requires a stable inbox batch id");
    if (s.lastDeliveryId === deliveryId) return;
    if (this.busy.has(id)) throw new Error("thread delivery already in progress");
    this.busy.add(id);
    try {
      await this.refreshShared(s);
      if (this.stopping) throw new Error("runtime is stopping; message not submitted");
      if (s.uncertainDelivery) throw new Error("external delivery is uncertain; inspect and reconcile before retrying");
      if (s.status !== "idle" && s.status !== "working") throw new DeliveryDeferred();
      const turnId = s.turnId;
      const method = s.status === "working" ? "turn/steer" : "turn/start";
      if (method === "turn/steer" && !turnId) throw new DeliveryDeferred();
      s.pendingDeliveryId = deliveryId; s.uncertainDelivery = true; this.save(s);
      try {
        const r = await this.codex.request(method, { threadId: id, input: [{ type: "text", text, text_elements: [] }], clientUserMessageId: deliveryId, ...(method === "turn/steer" ? { expectedTurnId: turnId } : {}) });
        const accepted = method === "turn/steer" ? r.turnId : r.turn?.id;
        if (typeof accepted !== "string" || !accepted || (method === "turn/steer" && accepted !== turnId)) throw new Error("external delivery response identity is unconfirmed");
        s.lastDeliveryId = deliveryId; s.pendingDeliveryId = undefined; s.uncertainDelivery = false;
        // Never infer native status here: UI turns may have advanced during the reply.
        s.status = "unknown"; this.save(s);
      } catch (e) {
        // A definitive precondition rejection submitted nothing. Leave the same batch queued;
        // a later duty pass refreshes identity. Never start a fallback turn in this attempt.
        if (e instanceof CodexRpcError && e.turnRace) {
          s.uncertainDelivery = false; s.pendingDeliveryId = undefined; s.status = "unknown"; this.save(s);
          throw new DeliveryDeferred();
        }
        s.status = "unknown"; s.uncertainDelivery = true; this.save(s); throw e;
      }
    } finally { this.busy.delete(id); }
  }

  private message(m: RpcMessage): void {
    const p = m.params ?? {};
    const s = this.sessions.get(p.threadId ?? p.thread?.id);
    if (m.id !== undefined && m.method) {
      if (this.codex.shared && (!s || s.closed || this.isExternalLead(s.id))) {
        if (s && !s.closed && this.isExternalLead(s.id)) {
          this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
          s.status = s.uncertainDelivery ? "unknown" : "blocked"; this.save(s);
        }
        return; // Never resolve/reject a native app request.
      }
      if (this.codex.shared && (typeof p.turnId !== "string" || p.turnId !== s!.ownedTurnId)) {
        if (this.submitting.has(s!.id) || s!.pendingOwnership?.turnId === p.turnId) this.deferredRequests.set(String(m.id), { id: m.id, method: m.method, params: p });
        return; // A Dori thread may currently contain native-created work.
      }
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
      const request = this.requests.get(String(p.requestId));
      if (request?.params.threadId === p.threadId) { this.requests.delete(String(p.requestId)); this.saveRequests(); }
      if (this.deferredRequests.get(String(p.requestId))?.params.threadId === p.threadId) this.deferredRequests.delete(String(p.requestId));
    }
    if (!s || s.closed) return;
    if (m.method === "thread/status/changed") {
      this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
      const status = p.status;
      s.status = s.uncertainDelivery ? "unknown" : status?.type === "active" ? Array.isArray(status.activeFlags) && status.activeFlags.length === 0 ? "working" : "blocked" : status?.type === "idle" ? this.idleStatus(s) : "unknown";
    } else if (m.method === "turn/started") {
      this.revisions.set(s.id, (this.revisions.get(s.id) ?? 0) + 1);
      // Shared notifications may originate in the native UI. Only our verified RPC
      // result can acknowledge a shared submission; an unrelated start proves nothing.
      if (!this.codex.shared && this.submitting.has(s.id)) { s.lastDeliveryId = s.pendingDeliveryId; s.uncertainDelivery = false; }
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
      this.terminal(s, turn);
      for (const [id, request] of this.deferredRequests) if (request.params.threadId === s.id && request.params.turnId === turn?.id) this.deferredRequests.delete(id);
      s.status = s.uncertainDelivery ? "unknown" : turn?.status === "completed" ? "done" : turn?.status === "interrupted" ? "idle" : turn?.status === "failed" ? "failed" : "unknown";
      s.turnId = undefined;
      for (const [id, request] of this.requests) if (request.params.threadId === s.id) this.requests.delete(id);
      this.saveRequests();
    } else return;
    this.save(s);
  }

  async reconcile(id: string, delivered: boolean): Promise<void> {
    const s = this.isExternalLead(id) ? this.sessions.get(id) : this.owned(id);
    if (!s || s.closed) throw new Error("session is not registered");
    if (this.busy.has(id) || this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread operation in progress; reconcile after it finishes");
    if (!s.uncertainDelivery) throw new Error("thread has no uncertain delivery");
    this.busy.add(id);
    try {
    if (this.codex.shared) await this.refreshShared(s); else await this.resume(s);
    const revision = this.revisions.get(id) ?? 0;
    const r = await this.codex.request("thread/read", { threadId: id, includeTurns: false });
    if ((this.revisions.get(id) ?? 0) !== revision) throw new Error("thread state changed during reconciliation; inspect it again");
    if (r.thread?.status?.type !== "idle") throw new Error("thread must be idle before reconciling delivery");
    if (delivered) s.lastDeliveryId = s.pendingDeliveryId;
    s.pendingDeliveryId = undefined; s.uncertainDelivery = false; s.status = s.requiresRecovery ? "recovery" : s.lastTurnStatus === "failed" ? "failed" : "idle"; this.save(s);
    } finally { this.busy.delete(id); }
  }

  async answer(id: string, result: unknown): Promise<void> {
    const request = this.requests.get(id);
    if (!request) throw new Error("request is no longer pending; refresh requests before answering");
    const s = this.owned(request.params.threadId);
    if (this.codex.shared && request.params.turnId !== s.ownedTurnId) throw new Error("request is not for a proven owned turn");
    this.codex.write({ id: request.id, result });
    this.requests.delete(id); this.saveRequests();
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
      const previousOwned = s.ownedTurnId, previousPending = s.pendingOwnership;
      if (this.codex.shared) await this.refreshShared(s); else await this.resume(s);
      if (this.codex.shared && previousOwned && !s.ownedTurnId && s.lastTurnId === previousOwned && ["completed", "failed", "interrupted"].includes(s.lastTurnStatus ?? "")) return;
      if (this.codex.shared && s.pendingOwnership) throw new Error("turn creation ownership is unresolved; interruption unconfirmed");
      if (this.codex.shared && previousPending && !s.pendingOwnership && !s.ownedTurnId) return;
      const turnId = this.codex.shared ? s.ownedTurnId : s.turnId;
      if (this.codex.shared && turnId && s.turnId && turnId !== s.turnId) throw new Error("native turn differs from the owned turn; interruption unconfirmed");
      if (!turnId) {
        if (s.uncertainDelivery || ["working", "blocked", "unknown"].includes(s.status)) throw new Error("active turn identity is unresolved; interruption unconfirmed");
        return;
      }
      try { await this.codex.request("turn/interrupt", { threadId: id, turnId }); }
      catch (e) { if (!this.finished.has(turnId)) throw e; }
      const until = Date.now() + this.interruptTimeoutMs;
      while (!(s.lastTurnId === turnId && s.lastTurnStatus === "interrupted")) {
        if (Date.now() >= until) {
          if (this.codex.shared) {
            const turns = await this.codex.request("thread/turns/list", { threadId: id, sortDirection: "desc", limit: 100, itemsView: "notLoaded" });
            const exact = turns.data?.find((t: any) => t.id === turnId);
            if (exact?.status === "interrupted") {
              s.lastTurnId = turnId; s.lastTurnStatus = "interrupted"; s.ownedTurnId = undefined;
              if (s.turnId === turnId) s.turnId = undefined;
              s.status = "idle"; this.save(s); return;
            }
          }
          throw new Error("interrupt acknowledged but interrupted completion is unconfirmed; ownership retained");
        }
        await Bun.sleep(10);
      }
    } finally { this.interrupting.delete(id); }
  }

  async close(id: string): Promise<void> {
    const s = this.owned(id);
    if (this.busy.has(id) || this.closing.has(id) || this.interrupting.has(id)) throw new Error("thread operation already in progress; finish it before closing");
    this.closing.add(id);
    try {
      if (["working", "blocked", "unknown", "recovery"].includes(await this.status(id))) throw new Error("finish or recover the turn before closing");
      await this.codex.request("thread/archive", { threadId: id });
      s.closed = true; s.status = "gone"; this.save(s);
    } finally { this.closing.delete(id); }
  }

  async review(text: string, cwd: string, model?: string): Promise<string> {
    const id = await this.create("review", cwd, "Review only. Never modify, push or merge anything. Finish with VERDICT: CLEAR or VERDICT: BLOCK.", model, true);
    if (this.codex.shared) return this.sharedReview(id, text);
    try {
      await this.deliver(id, text);
      const deadline = Date.now() + this.reviewTimeoutMs;
      while (Date.now() < deadline) {
        const s = this.owned(id);
        if (s.status === "done") return s.output;
        // Pending requests remain visible to the operator without losing the
        // result collector or deadline. Never answer them automatically.
        if (s.status === "unknown" || s.status === "failed" || s.status === "recovery") throw new Error("review failed or disconnected; no receipt written");
        await Bun.sleep(100);
      }
      await this.interrupt(id); throw new Error("review timed out; no receipt written");
    } finally {
      if (["done", "idle", "failed"].includes(this.sessions.get(id)?.status ?? "")) await this.close(id);
    }
  }

  private async sharedReview(id: string, text: string): Promise<string> {
    const clientId = randomUUID();
    let reviewed: AcceptedDelivery | undefined, terminal = false;
    try {
      await this.deliver(id, text, clientId);
      const s = this.owned(id), accepted = s.acceptedDelivery;
      if (!accepted || accepted.clientId !== clientId || accepted.created !== true) throw new Error("review was not proven newly created; no receipt written");
      reviewed = { ...accepted };
      const deadline = Date.now() + this.reviewTimeoutMs;
      while (Date.now() < deadline) {
        if (s.acceptedDelivery?.turnId !== reviewed.turnId || s.acceptedDelivery.clientId !== clientId || s.acceptedDelivery.created !== true) throw new Error("review submission identity changed; no receipt written");
        const exact = await this.historyTurn(id, reviewed.turnId, deadline);
        if (exact && ["completed", "failed", "interrupted"].includes(exact.status)) {
          terminal = true;
          if (exact.status !== "completed") throw new Error("review failed or interrupted; no receipt written");
          const items = await this.turnItems(id, reviewed.turnId, deadline);
          if (items.find(item => item.type === "userMessage")?.clientId !== clientId) throw new Error("review creation provenance changed; no receipt written");
          const final = items.filter(item => item.type === "agentMessage" && item.phase !== "commentary" && typeof item.text === "string").at(-1);
          if (!final) throw new Error("review final output is unconfirmed; no receipt written");
          return final.text;
        }
        await Bun.sleep(100);
      }
      if (s.ownedTurnId === reviewed.turnId) { await this.interrupt(id); terminal = true; }
      throw new Error("review timed out; no receipt written");
    } finally {
      // A raced native review or a newer native turn must never be archived by this collector.
      if (reviewed && terminal) await this.closeSharedReview(id, reviewed);
    }
  }

  private async closeSharedReview(id: string, reviewed: AcceptedDelivery): Promise<void> {
    const s = this.owned(id);
    if (this.busy.has(id) || this.closing.has(id) || this.interrupting.has(id)) return;
    this.closing.add(id);
    try {
      const revision = this.revisions.get(id) ?? 0;
      const state = await this.codex.request("thread/read", { threadId: id, includeTurns: false });
      const latest = (await this.codex.request("thread/turns/list", { threadId: id, sortDirection: "desc", limit: 1, itemsView: "notLoaded" })).data?.[0];
      if (state.thread?.id !== id || state.thread.status?.type !== "idle" || latest?.id !== reviewed.turnId || !["completed", "failed", "interrupted"].includes(latest.status) || (this.revisions.get(id) ?? 0) !== revision || s.acceptedDelivery?.turnId !== reviewed.turnId || s.acceptedDelivery.clientId !== reviewed.clientId || s.acceptedDelivery.created !== true) return;
      await this.codex.request("thread/archive", { threadId: id });
      s.closed = true; s.status = "gone"; this.save(s);
    } finally { this.closing.delete(id); }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    // Close admission, then drain every create/deliver continuation before taking the cleanup inventory.
    const until = Date.now() + 25_000;
    while (this.creating || this.busy.size) {
      if (Date.now() >= until) throw new Error("submission admission cleanup is unconfirmed; runtime ownership retained");
      await Bun.sleep(10);
    }
    const results = await Promise.allSettled([...this.sessions.values()].filter((s) => !s.closed && !this.isExternalLead(s.id) && (this.codex.shared ? s.ownedTurnId || s.pendingOwnership || s.uncertainDelivery : s.turnId)).map((s) => this.interrupt(s.id)));
    if (this.codex.shared && results.some(r => r.status === "rejected")) throw new Error("owned worker cleanup is unconfirmed; runtime ownership retained (shared service untouched)");
    await this.codex.disconnect();
  }
}

export async function serve(home: string, onTick: () => Promise<void> = async () => {}): Promise<never> {
  home = stateHome(home);
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
    const selected = readConnection(home);
    runtime = new Runtime(home, new Codex(selected));
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
          case "health": value = { pid: process.pid, sessions: runtime!.sessions.size, stopping, shutdownError, connection: selected }; break;
          case "registerExternalLead": value = await runtime!.registerExternalLead(a.threadId); break;
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
      } catch (e) { return Response.json({ error: e instanceof Error ? e.message : String(e), ...(e instanceof DeliveryDeferred ? { deferred: true } : {}) }, { status: 400 }); }
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
