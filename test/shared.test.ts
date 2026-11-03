import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Codex, type RpcMessage } from "../src/codex.ts";
import { Runtime } from "../src/runtime.ts";
import { connection, readConnection, saveConnection, type Connection } from "../src/connection.ts";
import { Sessions, socketPath } from "../src/sessions.ts";
import { ensureRuntime } from "../src/daemon.ts";
import { Store } from "../src/store.ts";
import { report, send, flushInbox, type Deps } from "../src/harness.ts";

type NativeTurn = { id: string; status: string; items: { type: string; id: string; clientId: string | null }[] };
type NativeThread = { id: string; name: string; status: { type: string; activeFlags?: string[] }; turns: NativeTurn[] };
class FakeSharedServer {
  readonly home = mkdtempSync(join(tmpdir(), "dori-shared-"));
  readonly path = join(this.home, "codex.sock");
  readonly selected: Connection = { mode: "shared", endpoint: `ws+unix://${this.path}`, lead: "native-lead" };
  readonly threads = new Map<string, NativeThread>();
  readonly calls: RpcMessage[] = [];
  readonly replies: RpcMessage[] = [];
  readonly peers = new Set<Bun.ServerWebSocket<undefined>>();
  hook?: (m: RpcMessage, ws: Bun.ServerWebSocket<undefined>) => boolean;
  interrupt: "notify" | "persist" | "ack" | "complete" = "notify";
  next = 0;
  readonly server: ReturnType<typeof Bun.serve<undefined>>;

  constructor() {
    this.thread("native-lead", "native-one"); this.thread("unrelated", "unrelated-one");
    this.server = Bun.serve<undefined>({ unix: this.path,
      fetch: (req, server) => server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade required", { status: 400 }),
      websocket: {
        open: ws => { this.peers.add(ws); }, close: ws => { this.peers.delete(ws); },
        message: (ws, data) => this.rpc(ws, JSON.parse(String(data))),
      },
    });
  }
  thread(id: string, turnId?: string): NativeThread {
    const t: NativeThread = { id, name: id === "native-lead" ? "🐶도리 studio" : id, status: turnId ? { type: "active", activeFlags: [] } : { type: "idle" }, turns: turnId ? [{ id: turnId, status: "inProgress", items: [{ type: "userMessage", id: `native-message-${turnId}`, clientId: `native-client-${turnId}` }] }] : [] };
    this.threads.set(id, t); return t;
  }
  event(method: string, params: unknown, id?: string): void { for (const ws of this.peers) ws.send(JSON.stringify({ method, params, ...(id ? { id } : {}) })); }
  drop(): void { for (const ws of this.peers) ws.terminate(); }
  count(method: string): number { return this.calls.filter(m => m.method === method).length; }
  private rpc(ws: Bun.ServerWebSocket<undefined>, m: RpcMessage): void {
    if (!m.method) { this.replies.push(m); return; }
    this.calls.push(m);
    if (this.hook?.(m, ws)) return;
    const p = m.params ?? {}, t = this.threads.get(p.threadId);
    const ok = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
    const fail = (message: string) => ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message } }));
    switch (m.method) {
      case "initialize": ok({ userAgent: "offline-fixture" }); return;
      case "initialized": return;
      case "thread/start": { const t = this.thread(`worker-${++this.next}`); ok({ thread: t }); return; }
      case "thread/name/set": if (t) t.name = p.name; ok({}); return;
      case "thread/read": if (!t) fail("thread not found"); else ok({ thread: t }); return;
      case "thread/resume": if (!t) fail("thread not found"); else { if (t.status.type === "notLoaded") t.status = { type: "idle" }; ok({ thread: t }); } return;
      case "thread/turns/list": ok({ data: t?.turns.slice(0, p.limit), nextCursor: null }); return;
      case "thread/items/list": ok({ data: t?.turns.find(turn => turn.id === p.turnId)?.items.map(item => ({ turnId: p.turnId, item, startedAtMs: null, completedAtMs: null })) ?? [], nextCursor: null }); return;
      case "turn/start": {
        if (!t) { fail("thread not found"); return; }
        const item = { type: "userMessage", id: `input-${++this.next}`, clientId: p.clientUserMessageId ?? null };
        // The native API adds input to an active turn instead of creating another.
        if (t.status.type === "active" && t.turns[0]?.status === "inProgress") { t.turns[0].items.push(item); ok({ turn: t.turns[0] }); return; }
        if (t.status.type !== "idle") { fail("thread is not ready"); return; }
        const turn = { id: `started-${++this.next}`, status: "inProgress", items: [item] };
        t.turns.unshift(turn); t.status = { type: "active", activeFlags: [] };
        ok({ turn }); this.event("turn/started", { threadId: t.id, turn }); return;
      }
      case "turn/steer": {
        if (!t || t.status.type !== "active" || t.turns[0]?.id !== p.expectedTurnId) { fail("expected turn id does not match current active turn"); return; }
        t.turns[0]!.items.push({ type: "userMessage", id: `steered-${++this.next}`, clientId: p.clientUserMessageId ?? null });
        ok({ turnId: p.expectedTurnId }); return;
      }
      case "turn/interrupt": {
        if (!t || t.status.type !== "active" || t.turns[0]?.id !== p.turnId || t.turns[0]?.status !== "inProgress") { fail("no active turn to interrupt"); return; }
        ok({});
        if (!t || this.interrupt === "ack") return;
        const turn = t.turns.find(t => t.id === p.turnId)!;
        turn.status = this.interrupt === "complete" ? "completed" : "interrupted"; t.status = { type: "idle" };
        if (this.interrupt !== "persist") this.event("turn/completed", { threadId: t.id, turn });
        return;
      }
      case "thread/archive": this.threads.delete(p.threadId); ok({}); return;
      default: fail("unsupported method");
    }
  }
  stop(): void { this.drop(); this.server.stop(true); if (existsSync(this.path)) unlinkSync(this.path); rmSync(this.home, { recursive: true, force: true }); }
}

const fixtures: { fake: FakeSharedServer; runtime: Runtime }[] = [];
afterEach(async () => { for (const { fake, runtime } of fixtures.splice(0)) { await runtime.codex.disconnect(); fake.stop(); } });
async function setup(register = true) {
  const fake = new FakeSharedServer();
  const runtime = new Runtime(fake.home, new Codex(fake.selected, 250), 1000, 40);
  fixtures.push({ fake, runtime });
  await runtime.codex.connect();
  if (register) await runtime.registerExternalLead("native-lead");
  return { fake, runtime };
}
function deps(fake: FakeSharedServer, runtime: Runtime): Deps {
  const store = new Store(fake.home); store.setRole("lead", "native-lead");
  return { store, now: Date.now, doriCmd: "fixture-dori", host: () => ({ load1: 0, cores: 8, memFreePct: 80 }), exec: async () => { throw new Error("fixture external execution refused"); }, sessions: {
    known: id => runtime.sessions.has(id), isExternalLead: id => runtime.isExternalLead(id),
    create: (...a) => runtime.create(...a), status: id => runtime.status(id), deliver: (...a) => runtime.deliver(...a),
    close: id => runtime.close(id), read: async id => runtime.sessions.get(id)?.output ?? "", review: (...a) => runtime.review(...a),
  } };
}
async function until(fn: () => boolean) { const deadline = Date.now() + 1500; while (!fn()) { if (Date.now() > deadline) throw new Error("offline fixture deadline"); await Bun.sleep(5); } }

test("external registration proves already loaded, preserves title and resumes without any policy override", async () => {
  const { fake, runtime } = await setup();
  expect(runtime.sessions.get("native-lead")).toMatchObject({ externalLead: true, name: "🐶도리 studio", status: "working" });
  expect(fake.calls.filter(m => m.method === "thread/resume").map(m => m.params)).toEqual([{ threadId: "native-lead", excludeTurns: true }]);
  const requests = fake.calls.filter(m => m.id !== undefined);
  expect(requests[1]).toMatchObject({ method: "thread/read", params: { includeTurns: false } });
  expect(fake.count("thread/start")).toBe(0); expect(fake.count("thread/name/set")).toBe(0);
  await expect(runtime.registerExternalLead("replacement")).rejects.toThrow("selected shared connection");
});

test("initial registration rejects unloaded and missing leads without loading them", async () => {
  const { fake, runtime } = await setup(false);
  fake.threads.get("native-lead")!.status = { type: "notLoaded" };
  await expect(runtime.registerExternalLead("native-lead")).rejects.toThrow("already be loaded");
  fake.threads.delete("native-lead");
  await expect(runtime.registerExternalLead("native-lead")).rejects.toThrow("no rollout");
  expect(fake.count("thread/resume")).toBe(0); expect(runtime.sessions.has("native-lead")).toBe(false);
});

test("report steers an active external lead and idle delivery wakes it, using durable batch IDs", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  d.store.saveLane({ key: "sample", threadId: "worker-lane", brief: "fixture", cwd: fake.home, status: "working", createdAt: 1, lastActivityAt: 1, nudges: 0, log: [] });
  await report(d, "sample", "milestone");
  const steer = fake.calls.find(m => m.method === "turn/steer")!;
  expect(steer.params).toMatchObject({ threadId: "native-lead", expectedTurnId: "native-one", input: [{ type: "text", text: "[REPORT sample] milestone" }] });
  expect(steer.params.clientUserMessageId).toBeString(); expect(d.store.queued("native-lead")).toHaveLength(0);
  fake.threads.get("native-lead")!.status = { type: "idle" };
  expect(await send(d, "lead", "wake", "cli")).toBe("DELIVERED");
  const start = fake.calls.find(m => m.method === "turn/start")!;
  expect(start.params.clientUserMessageId).toBeString(); expect(start.params.clientUserMessageId).not.toBe(steer.params.clientUserMessageId);
  expect(Object.keys(start.params).sort()).toEqual(["clientUserMessageId", "input", "threadId"]);
});

test("owned busy workers and native approval/input blocked leads keep inboxes queued", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  const worker = await runtime.create("topic", fake.home, "worker instructions");
  expect(fake.threads.get(worker)?.name).toBe("🐾dori/topic");
  await runtime.deliver(worker, "work", "worker-batch");
  expect(await send(d, worker, "next", "cli")).toBe("QUEUED");
  for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
    fake.threads.get("native-lead")!.status = { type: "active", activeFlags: [flag] };
    expect(await send(d, "lead", flag, "cli")).toBe("QUEUED");
  }
  expect(fake.count("turn/steer")).toBe(0); expect(fake.count("turn/start")).toBe(1);
});

test("native UI turn changes replace stale current-turn identities before steering", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  runtime.sessions.get("native-lead")!.turnId = "stale";
  fake.thread("native-lead", "ui-new-turn"); // No notification: refresh must discover it.
  expect(await send(d, "lead", "report", "cli")).toBe("DELIVERED");
  expect(fake.calls.find(m => m.method === "turn/steer")?.params.expectedTurnId).toBe("ui-new-turn");
});

test("a definitive turn race keeps the batch queued and never starts a fallback turn", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  fake.hook = (m, ws) => {
    if (m.method !== "turn/steer") return false;
    fake.threads.get("native-lead")!.status = { type: "idle" };
    ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: "expected turn id does not match current active turn" } })); return true;
  };
  expect(await send(d, "lead", "race", "cli")).toBe("QUEUED");
  const batch = d.store.inboxBatch("native-lead")!;
  expect(fake.count("turn/start")).toBe(0); expect(runtime.sessions.get("native-lead")?.uncertainDelivery).toBe(false);
  fake.hook = undefined;
  expect(await flushInbox(d, "native-lead")).toBe(true);
  expect(fake.calls.find(m => m.method === "turn/start")?.params.clientUserMessageId).toBe(batch.id);
});

test("timeout and unsolicited native turn/started never certify acceptance or replay after reconnect", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  fake.hook = (m) => {
    if (m.method !== "turn/steer") return false;
    fake.event("turn/started", { threadId: "native-lead", turn: { id: "unrelated-ui-turn", status: "inProgress" } });
    return true; // Lost response: acceptance is unknown.
  };
  await expect(send(d, "lead", "uncertain", "cli")).rejects.toThrow("timeout");
  expect(runtime.sessions.get("native-lead")?.uncertainDelivery).toBe(true);
  expect(d.store.queued("native-lead")).toHaveLength(1);
  fake.hook = undefined; fake.drop(); await until(() => !runtime.codex.connected);
  fake.threads.get("native-lead")!.status = { type: "idle" };
  expect(await flushInbox(d, "native-lead")).toBe(false);
  expect(fake.count("turn/start")).toBe(0); expect(fake.count("turn/steer")).toBe(1);
  expect(fake.calls.filter(m => m.method === "thread/resume").every(m => Object.keys(m.params).sort().join() === "excludeTurns,threadId")).toBe(true);
});

test("a native UI turn during owned shared-worker submission cannot acknowledge the pending batch", async () => {
  const { fake, runtime } = await setup(), d = deps(fake, runtime);
  const id = await runtime.create("worker-race", fake.home, "fixture");
  fake.hook = m => {
    if (m.method !== "turn/start") return false;
    const native = fake.thread(id, "native-ui-race-turn");
    fake.event("turn/started", { threadId: id, turn: native.turns[0] });
    fake.event("item/commandExecution/requestApproval", { threadId: "native-lead" }, "external-during-race");
    fake.event("item/tool/requestUserInput", { threadId: "unrelated" }, "unrelated-during-race");
    return true; // No verified RPC result and no matching clientUserMessageId.
  };
  await expect(send(d, id, "uncertain worker input", "cli")).rejects.toThrow("timeout");
  const s = runtime.sessions.get(id)!;
  expect(s.uncertainDelivery).toBe(true); expect(s.lastDeliveryId).toBeUndefined(); expect(s.ownedTurnId).toBeUndefined();
  expect(s.pendingDeliveryId).toBe(d.store.inboxBatch(id)?.id); expect(d.store.queued(id)).toHaveLength(1);
  expect(runtime.requests.size).toBe(0); expect(fake.replies).toHaveLength(0);
  fake.hook = undefined; fake.threads.get(id)!.status = { type: "idle" };
  expect(await flushInbox(d, id)).toBe(false); expect(fake.count("turn/start")).toBe(1);
});

test("wrong steer response or disconnect leaves uncertainty and no automatic replay", async () => {
  for (const mode of ["wrong", "disconnect"]) {
    const { fake, runtime } = await setup(), d = deps(fake, runtime);
    fake.hook = (m, ws) => {
      if (m.method !== "turn/steer") return false;
      if (mode === "wrong") ws.send(JSON.stringify({ id: m.id, result: { turnId: "different" } })); else ws.terminate();
      return true;
    };
    await expect(send(d, "lead", "x", "cli")).rejects.toThrow(mode === "wrong" ? "unconfirmed" : "disconnected");
    expect(runtime.sessions.get("native-lead")?.uncertainDelivery).toBe(true);
    fake.hook = undefined; fake.threads.get("native-lead")!.status = { type: "idle" };
    expect(await flushInbox(d, "native-lead")).toBe(false); expect(fake.count("turn/start")).toBe(0);
  }
});

test("approval/input requests for external and unrelated chats are ignored; owned requests remain explicit", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("worker", fake.home, "fixture");
  await runtime.deliver(id, "work", "approval-worker-batch");
  fake.event("item/commandExecution/requestApproval", { threadId: "native-lead" }, "external-request");
  fake.event("item/tool/requestUserInput", { threadId: "unrelated" }, "unrelated-request");
  fake.event("item/tool/requestUserInput", { threadId: id, turnId: runtime.sessions.get(id)?.ownedTurnId }, "owned-request");
  await until(() => runtime.requests.size === 1);
  expect([...runtime.requests.keys()]).toEqual(["owned-request"]); expect(fake.replies).toHaveLength(0);
  await expect(runtime.answer("external-request", {})).rejects.toThrow("no longer pending");
  await runtime.answer("owned-request", { answers: {} }); await until(() => fake.replies.length === 1);
  expect(fake.replies[0]?.id).toBe("owned-request");
});

test("external lead cannot be interrupted, archived, or closed, including after reload", async () => {
  const { fake, runtime } = await setup();
  for (const r of [runtime, new Runtime(fake.home, runtime.codex)]) {
    await expect(r.interrupt("native-lead")).rejects.toThrow("external lead is protected");
    await expect(r.close("native-lead")).rejects.toThrow("external lead is protected");
  }
  expect(fake.count("turn/interrupt")).toBe(0); expect(fake.count("thread/archive")).toBe(0);
});

test("worker interrupt requires interrupted completion; exact persisted outcome recovers missed notification", async () => {
  for (const mode of ["notify", "persist"] as const) {
    const { fake, runtime } = await setup(); fake.interrupt = mode;
    const id = await runtime.create(mode, fake.home, "fixture"); await runtime.deliver(id, "work", `batch-${mode}`);
    const turn = runtime.sessions.get(id)!.ownedTurnId;
    await runtime.interrupt(id);
    expect(runtime.sessions.get(id)).toMatchObject({ lastTurnId: turn, lastTurnStatus: "interrupted" });
  }
});

test("ACK alone or completed instead of interrupted is unconfirmed and retains runtime ownership", async () => {
  for (const mode of ["ack", "complete"] as const) {
    const { fake, runtime } = await setup(); fake.interrupt = mode;
    const id = await runtime.create(mode, fake.home, "fixture"); await runtime.deliver(id, "work", `batch-${mode}`);
    await expect(runtime.interrupt(id)).rejects.toThrow("interrupted completion is unconfirmed");
    if (mode === "ack") {
      await expect(runtime.shutdown()).rejects.toThrow("cleanup is unconfirmed");
      expect(runtime.codex.connected).toBe(true); expect(runtime.sessions.get(id)?.ownedTurnId).toBeString();
    }
    expect(fake.threads.get("native-lead")?.status.type).toBe("active");
    expect(fake.threads.get("unrelated")?.status.type).toBe("active");
  }
});

test("shutdown interrupts only its owned worker turn and disconnects, leaving shared service/native work alive", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("worker", fake.home, "fixture"); await runtime.deliver(id, "work", "worker-batch");
  await runtime.shutdown();
  expect(fake.calls.filter(m => m.method === "turn/interrupt").map(m => m.params.threadId)).toEqual([id]);
  expect(fake.count("thread/archive")).toBe(0); expect(runtime.codex.connected).toBe(false);
  expect(fake.threads.get("native-lead")?.status.type).toBe("active"); expect(fake.threads.get("unrelated")?.status.type).toBe("active");
  const observer = new Codex(fake.selected, 250); await observer.connect();
  expect((await observer.request("thread/read", { threadId: "native-lead" })).thread.name).toBe("🐶도리 studio");
  await observer.disconnect();
});

test("native turns started on an owned thread are never interrupted as if Dori created them", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("worker", fake.home, "fixture");
  fake.thread(id, "ui-owned-thread-turn");
  await expect(runtime.interrupt(id)).rejects.toThrow("identity is unresolved");
  await runtime.shutdown(); expect(fake.count("turn/interrupt")).toBe(0);
});

test("exact persisted terminal outcomes release owned turn markers, including runtime reload", async () => {
  for (const outcome of ["completed", "failed", "interrupted"]) {
    const { fake, runtime } = await setup();
    const id = await runtime.create(outcome, fake.home, "fixture"); await runtime.deliver(id, "work", `batch-${outcome}`);
    const turn = fake.threads.get(id)!.turns[0]!;
    expect(runtime.sessions.get(id)?.ownedTurnId).toBe(turn.id);
    turn.status = outcome; fake.threads.get(id)!.status = { type: "idle" }; // Missed turn/completed.
    await runtime.codex.disconnect();
    const reloaded = new Runtime(fake.home, new Codex(fake.selected, 250), 1000, 40);
    fixtures.find(f => f.runtime === runtime)!.runtime = reloaded;
    expect(await reloaded.status(id)).toBe(outcome === "completed" ? "done" : outcome === "failed" ? "failed" : "idle");
    expect(reloaded.sessions.get(id)?.ownedTurnId).toBeUndefined();
    expect(reloaded.sessions.get(id)?.lastTurnId).toBe(turn.id);
    await reloaded.shutdown(); expect(fake.count("turn/interrupt")).toBe(0);
  }
});

test("turn/start racing a native turn accepts input without claiming or interrupting native creation", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("native-race", fake.home, "fixture");
  let raced = false;
  fake.hook = m => {
    if (m.method !== "turn/start" || raced) return false;
    raced = true; fake.thread(id, "native-created-before-admission"); return false;
  };
  await runtime.deliver(id, "accepted into native work", "dori-followup-batch");
  const turn = fake.threads.get(id)!.turns[0]!;
  expect(turn.items.map(item => item.clientId)).toEqual(["native-client-native-created-before-admission", "dori-followup-batch"]);
  expect(runtime.sessions.get(id)?.lastDeliveryId).toBe("dori-followup-batch");
  expect(runtime.sessions.get(id)?.ownedTurnId).toBeUndefined(); expect(runtime.sessions.get(id)?.pendingOwnership).toBeUndefined();
  fake.event("item/commandExecution/requestApproval", { threadId: id, turnId: turn.id }, "native-owned-thread-request");
  await Bun.sleep(10);
  expect(runtime.requests.size).toBe(0); expect(fake.replies).toHaveLength(0);
  await runtime.shutdown(); expect(turn.status).toBe("inProgress"); expect(fake.count("turn/interrupt")).toBe(0);
});

test("missing first-message provenance keeps creation ownership unresolved and cleanup conservative", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("unproven", fake.home, "fixture");
  fake.hook = (m, ws) => {
    if (m.method !== "thread/items/list") return false;
    ws.send(JSON.stringify({ id: m.id, result: { data: [], nextCursor: null } })); return true;
  };
  await runtime.deliver(id, "work", "unproven-batch");
  expect(runtime.sessions.get(id)?.ownedTurnId).toBeUndefined(); expect(runtime.sessions.get(id)?.pendingOwnership).toMatchObject({ clientId: "unproven-batch" });
  await expect(runtime.shutdown()).rejects.toThrow("cleanup is unconfirmed");
  expect(fake.count("turn/interrupt")).toBe(0); expect(runtime.codex.connected).toBe(true);
});

test("shutdown closes admission while a second worker awaits refresh, then inventories owned turns", async () => {
  const { fake, runtime } = await setup();
  const active = await runtime.create("active", fake.home, "fixture"); await runtime.deliver(active, "work", "active-batch");
  const pending = await runtime.create("refreshing", fake.home, "fixture");
  let held: { ws: Bun.ServerWebSocket<undefined>; id: unknown } | undefined;
  fake.hook = (m, ws) => {
    if (m.method !== "thread/read" || m.params.threadId !== pending || held) return false;
    held = { ws, id: m.id }; return true;
  };
  const delivery = runtime.deliver(pending, "must not start", "pending-batch").then(() => "accepted", e => String(e));
  await until(() => !!held);
  const shutdown = runtime.shutdown();
  expect(runtime.stopping).toBe(true); expect(fake.count("turn/interrupt")).toBe(0);
  held!.ws.send(JSON.stringify({ id: held!.id, result: { thread: fake.threads.get(pending) } }));
  expect(await delivery).toContain("runtime is stopping"); await shutdown;
  expect(fake.threads.get(pending)?.status.type).toBe("idle"); expect(fake.count("turn/start")).toBe(1);
  expect(fake.calls.filter(m => m.method === "turn/interrupt").map(m => m.params.threadId)).toEqual([active]);
});

test("shutdown drains already submitted turns and pending thread creation before disconnecting", async () => {
  const { fake, runtime } = await setup();
  const id = await runtime.create("submitting", fake.home, "fixture");
  let held: { ws: Bun.ServerWebSocket<undefined>; id: unknown; turn: NativeTurn } | undefined;
  fake.hook = (m, ws) => {
    if (m.method !== "turn/start") return false;
    const t = fake.thread(id, "dori-admitted-turn"); t.turns[0]!.items[0]!.clientId = m.params.clientUserMessageId;
    held = { ws, id: m.id, turn: t.turns[0]! }; return true;
  };
  const delivery = runtime.deliver(id, "already in flight", "inflight-batch"); await until(() => !!held);
  const shutdown = runtime.shutdown(); expect(fake.count("turn/interrupt")).toBe(0);
  held!.ws.send(JSON.stringify({ id: held!.id, result: { turn: held!.turn } }));
  await delivery; await shutdown; expect(fake.threads.get(id)?.turns[0]?.status).toBe("interrupted");
  expect(fake.count("turn/interrupt")).toBe(1);
});

test("thread creation awaiting connection cannot admit work after shutdown starts", async () => {
  const { fake, runtime } = await setup();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  runtime.codex.connect = async () => held;
  const creation = runtime.create("late", fake.home, "fixture").then(() => "created", e => String(e));
  const shutdown = runtime.shutdown(); release();
  expect(await creation).toContain("runtime is stopping"); await shutdown;
  expect(fake.count("thread/start")).toBe(0);
});

test("shared successful review survives completed then idle notifications", async () => {
  const { fake, runtime } = await setup();
  fake.hook = (m, ws) => {
    if (m.method !== "turn/start") return false;
    const t = fake.thread(m.params.threadId, "review-complete-turn"), turn = t.turns[0]!;
    turn.items[0]!.clientId = m.params.clientUserMessageId;
    ws.send(JSON.stringify({ id: m.id, result: { turn } })); fake.event("turn/started", { threadId: t.id, turn });
    setTimeout(() => {
      turn.status = "completed"; t.status = { type: "idle" };
      fake.event("item/completed", { threadId: t.id, turnId: turn.id, item: { type: "agentMessage", text: "VERDICT: CLEAR", phase: "final_answer" } });
      fake.event("turn/completed", { threadId: t.id, turn }); fake.event("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
    }, 10);
    return true;
  };
  expect(await runtime.review("review", fake.home)).toBe("VERDICT: CLEAR");
  expect([...runtime.sessions.values()].find(s => s.name === "review")).toMatchObject({ lastTurnStatus: "completed", closed: true });
});

test("shared failed and completed terminal outcomes survive later idle notifications", async () => {
  for (const outcome of ["failed", "completed"]) {
    const { fake, runtime } = await setup(); const id = await runtime.create(outcome, fake.home, "fixture");
    await runtime.deliver(id, "work", `terminal-${outcome}`);
    const t = fake.threads.get(id)!, turn = t.turns[0]!; turn.status = outcome; t.status = { type: "idle" };
    fake.event("turn/completed", { threadId: id, turn }); fake.event("thread/status/changed", { threadId: id, status: { type: "idle" } });
    await until(() => runtime.sessions.get(id)?.lastTurnStatus === outcome);
    expect(runtime.sessions.get(id)?.status).toBe(outcome === "failed" ? "failed" : "done");
    expect(await runtime.status(id)).toBe(outcome === "failed" ? "failed" : "done");
  }
});

for (const outcome of ["completed", "failed"]) {
  test(`external ${outcome} then native idle permits a fresh notification turn`, async () => {
    const { fake, runtime } = await setup(), d = deps(fake, runtime);
    const t = fake.threads.get("native-lead")!, turn = t.turns[0]!;
    turn.status = outcome; t.status = { type: "idle" };
    fake.event("turn/completed", { threadId: t.id, turn });
    fake.event("thread/status/changed", { threadId: t.id, status: { type: "idle" } });
    await until(() => runtime.sessions.get(t.id)?.lastTurnStatus === outcome);
    expect(await runtime.status(t.id)).toBe("idle");
    expect(await send(d, "lead", `wake after ${outcome}`, "cli")).toBe("DELIVERED");
    expect(fake.count("turn/start")).toBe(1); expect(fake.count("turn/steer")).toBe(0);
    expect(runtime.sessions.get(t.id)?.ownedTurnId).toBeUndefined();
  });
}

test("RPC error payloads are not copied to callers and pending calls reject promptly on disconnect", async () => {
  const { fake, runtime } = await setup();
  fake.hook = (m, ws) => { if (m.method !== "fixture/error") return false; ws.send(JSON.stringify({ id: m.id, error: { code: -999, message: "SECRET arbitrary payload" } })); return true; };
  await expect(runtime.codex.request("fixture/error")).rejects.toThrow("Codex RPC rejected (-999)");
  fake.hook = m => m.method === "fixture/pending";
  const pending = runtime.codex.request("fixture/pending", {}, 10_000);
  fake.drop(); const started = Date.now(); await expect(pending).rejects.toThrow("disconnected");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("shared initialization is bounded and an idle-start timeout keeps the accepted batch uncertain", async () => {
  const { fake, runtime } = await setup();
  await runtime.codex.disconnect();
  fake.hook = m => m.method === "initialize";
  const start = Date.now();
  await expect(runtime.codex.connect()).rejects.toThrow("timeout");
  expect(Date.now() - start).toBeLessThan(1500);
  fake.hook = undefined; await runtime.codex.connect();
  fake.threads.get("native-lead")!.status = { type: "idle" };
  fake.hook = m => {
    if (m.method !== "turn/start") return false;
    const t = fake.thread("native-lead", "accepted-but-no-response");
    fake.event("turn/started", { threadId: t.id, turn: t.turns[0] }); return true;
  };
  const d = deps(fake, runtime);
  await expect(send(d, "lead", "idle uncertain", "cli")).rejects.toThrow("timeout");
  expect(runtime.sessions.get("native-lead")?.uncertainDelivery).toBe(true);
  fake.hook = undefined; fake.threads.get("native-lead")!.status = { type: "idle" };
  expect(await flushInbox(d, "native-lead")).toBe(false); expect(fake.count("turn/start")).toBe(1);
});

test("thread creation cannot overwrite or rename the protected external lead", async () => {
  const { fake, runtime } = await setup();
  fake.hook = (m, ws) => {
    if (m.method !== "thread/start") return false;
    ws.send(JSON.stringify({ id: m.id, result: { thread: fake.threads.get("native-lead") } })); return true;
  };
  await expect(runtime.create("review", fake.home, "fixture", undefined, true)).rejects.toThrow("protected thread");
  expect(fake.count("thread/name/set")).toBe(0); expect(runtime.sessions.get("native-lead")?.externalLead).toBe(true);
});

test("connection validation and per-home settings exclude TCP and retain exact selected endpoint/lead", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-connection-"));
  try {
    for (const endpoint of ["ws://localhost:1234", "wss://example.com", "ws+unix://host/tmp/x", "ws+unix:///tmp/../x", "ws+unix:///tmp/x?token=y", "ws+unix:///tmp/x%00", "ws+unix:///tmp/x#fragment"]) expect(() => connection({ mode: "shared", endpoint, lead: "lead" })).toThrow();
    const selected = connection({ mode: "shared", endpoint: "ws+unix:///tmp/offline.sock", lead: "lead" });
    saveConnection(home, selected); expect(readConnection(home)).toEqual(selected);
    expect(JSON.parse(readFileSync(join(home, "connection.json"), "utf8"))).toEqual(selected);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a live connection mode/endpoint/lead mismatch refuses without changing saved config or spawning", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-mismatch-")), path = socketPath(home);
  const live: Connection = { mode: "shared", endpoint: "ws+unix:///tmp/one.sock", lead: "lead-one" };
  saveConnection(home, live);
  const server = Bun.serve({ unix: path, fetch: () => Response.json({ value: { stopping: false, connection: live } }) });
  try {
    for (const requested of [{ mode: "owned" } as Connection, { ...live, endpoint: "ws+unix:///tmp/two.sock" }, { ...live, lead: "lead-two" }]) await expect(ensureRuntime(home, false, requested)).rejects.toThrow("differs");
    expect(readConnection(home)).toEqual(live); expect(existsSync(join(home, "runtime.log"))).toBe(false);
  } finally { server.stop(true); if (existsSync(path)) unlinkSync(path); rmSync(home, { recursive: true, force: true }); }
});

test("shared CLI up registers this chat, persists across restart, creates no synthetic model leads, down preserves server", async () => {
  const fake = new FakeSharedServer();
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], { env: { ...process.env, DORI_HOME: fake.home, DORI_CODEX_BIN: "/offline-must-never-spawn-codex" }, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0) throw new Error(`fixture CLI failed: ${err}`); return out;
  };
  try {
    expect(await cli("up", "--connect", fake.selected.mode === "shared" ? fake.selected.endpoint : "", "--lead", "native-lead")).toContain("duty=code");
    expect(fake.count("thread/start")).toBe(0); expect(new Store(fake.home).roles()).toEqual({ lead: "native-lead" });
    expect(await cli("send", "lead", "--text", "integration report")).toContain("DELIVERED");
    expect(await cli("down")).toContain("DOWN");
    expect(fake.threads.get("native-lead")?.status.type).toBe("active"); expect(fake.threads.get("unrelated")?.status.type).toBe("active");
    expect(await cli("up")).toContain("mode=shared"); expect(fake.count("thread/start")).toBe(0);
    expect(await cli("down")).toContain("DOWN");
    expect(fake.count("turn/interrupt")).toBe(0); expect(fake.count("thread/archive")).toBe(0);
  } finally {
    if (existsSync(socketPath(fake.home))) { await new Sessions(fake.home).call("shutdown").catch(() => {}); await until(() => !existsSync(socketPath(fake.home))); }
    fake.stop();
  }
}, 15_000);
