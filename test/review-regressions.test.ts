import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Codex } from "../src/codex.ts";
import { Runtime } from "../src/runtime.ts";
import { startLane } from "../src/harness.ts";
import { World } from "./fake.ts";
const homes: string[] = [];
const home = () => { const p = mkdtempSync(join(tmpdir(), "dori-review-regression-")); homes.push(p); return p; };
afterEach(() => { for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true }); });
const mock = (request: (method: string, params?: any) => Promise<any>) => ({ request, write() {}, disconnect: async () => {}, onMessage: () => {}, onExit: () => {} }) as unknown as Codex;

test("crash before turn/start acceptance preserves uncertainty and never resubmits after restart", async () => {
  const root = home(); let firstStarts = 0, replayStarts = 0;
  const r = new Runtime(root, mock(async (method) => {
    if (method === "thread/start") return { thread: { id: "crash-thread" } };
    if (method === "turn/start") { firstStarts++; return new Promise(() => {}); }
    return {};
  }));
  const id = await r.create("sample", root, "fixture"); void r.deliver(id, "effectful task", "stable-batch"); await Bun.sleep(1);
  await expect(r.reconcile(id, false)).rejects.toThrow("operation in progress");
  const saved = JSON.parse(readFileSync(join(root, "sessions", id + ".json"), "utf8"));
  expect(saved.uncertainDelivery).toBe(true);
  const restarted = new Runtime(root, mock(async (method) => {
    if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
    if (method === "turn/start") { replayStarts++; return { turn: { id: "duplicate" } }; }
    return {};
  }));
  expect(await restarted.status(id)).toBe("unknown");
  await expect(restarted.deliver(id, "effectful task", "stable-batch")).rejects.toThrow("unknown");
  expect([firstStarts, replayStarts]).toEqual([1, 0]);
});

test("uncertain kickoff remains an open lane with one durable batch and cannot allocate a replacement", async () => {
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture"); const active = new Set<string>();
  d.sessions.deliver = async (id) => { active.add(id); throw new Error("submission uncertain"); };
  await expect(startLane(d, "sample-task", brief)).rejects.toThrow("submission uncertain");
  await expect(startLane(d, "sample-task", brief)).rejects.toThrow("already open");
  const lane = d.store.lane("sample-task")!;
  expect(lane.status).toBe("waiting"); expect(active.size).toBe(1);
  expect(d.store.queued(lane.threadId)).toHaveLength(1);
  expect(d.store.inboxBatch(lane.threadId)?.id).toBeTruthy();
});

test("initial status and delivery share one resume so a stale idle reply cannot overwrite a new turn", async () => {
  const root = home(); mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "sessions/resume-thread.json"), JSON.stringify({ id: "resume-thread", name: "fixture", cwd: root, instructions: "", status: "idle", output: "", everStarted: true }));
  let release!: (value: unknown) => void, resumes = 0, starts = 0;
  const r = new Runtime(root, mock(async (method) => {
    if (method === "thread/resume") { resumes++; return await new Promise((resolve) => { release = resolve; }); }
    if (method === "turn/start") { starts++; return { turn: { id: "new-turn" } }; }
    return {};
  }));
  const status = r.status("resume-thread"), delivery = r.deliver("resume-thread", "first", "batch-one"); await Bun.sleep(1);
  expect(resumes).toBe(1); release({ thread: { status: { type: "idle" } } }); await Promise.all([status, delivery]);
  expect(await r.status("resume-thread")).toBe("working");
  await expect(r.deliver("resume-thread", "second", "batch-two")).rejects.toThrow("working"); expect(starts).toBe(1);
});

test("ignored metadata notifications do not veto the authoritative resume state", async () => {
  const root = home(); mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "sessions/resume-thread.json"), JSON.stringify({ id: "resume-thread", name: "fixture", cwd: root, instructions: "", status: "unknown", output: "", everStarted: true }));
  const c = mock(async (method) => {
    if (method === "thread/resume") {
      c.onMessage({ method: "thread/tokenUsage/updated", params: { threadId: "resume-thread", tokenUsage: { total: { totalTokens: 1 }, last: { totalTokens: 1 }, modelContextWindow: null } } });
      return { thread: { status: { type: "idle" } } };
    }
    if (method === "thread/turns/list") return { data: [{ id: "saved-turn", status: "completed" }] };
    return {};
  });
  const r = new Runtime(root, c); expect(await r.status("resume-thread")).toBe("done");
});

test("resumed lifecycle events cannot accept an uncertain saved delivery, and reconciliation rejects races", async () => {
  const root = home(); mkdirSync(join(root, "sessions"));
  writeFileSync(join(root, "sessions/pending-thread.json"), JSON.stringify({ id: "pending-thread", name: "fixture", cwd: root, instructions: "", status: "unknown", output: "", everStarted: true, uncertainDelivery: true, pendingDeliveryId: "pending-batch" }));
  let release!: (value: unknown) => void;
  const c = mock(async (method) => method === "thread/read" ? await new Promise((resolve) => { release = resolve; }) : { thread: { status: { type: "idle" } } });
  const r = new Runtime(root, c); await r.status("pending-thread");
  c.onMessage({ method: "turn/started", params: { threadId: "pending-thread", turn: { id: "other-turn" } } });
  c.onMessage({ method: "turn/completed", params: { threadId: "pending-thread", turn: { id: "other-turn", status: "completed" } } });
  expect(r.sessions.get("pending-thread")).toMatchObject({ status: "unknown", uncertainDelivery: true });
  expect(r.sessions.get("pending-thread")?.lastDeliveryId).toBeUndefined();
  const reconciliation = r.reconcile("pending-thread", false); await Bun.sleep(1);
  c.onMessage({ method: "turn/started", params: { threadId: "pending-thread", turn: { id: "newer-turn" } } });
  release({ thread: { status: { type: "idle" } } });
  await expect(reconciliation).rejects.toThrow("changed during reconciliation");
  expect(r.sessions.get("pending-thread")?.uncertainDelivery).toBe(true);
});

test("concurrent starts of one lane key cannot allocate two model tasks", async () => {
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture");
  const results = await Promise.allSettled([startLane(d, "one-task", brief), startLane(d, "one-task", brief)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(w.calls.filter((c) => c.cmd === "sessions" && c.argv[0] === "create")).toHaveLength(1);
  expect(d.store.lanes()).toHaveLength(1);
});

test("an awaited duty status cannot overwrite a lane that became READY during the wait", async () => {
  const { dutyTick, ready } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture"); const lane = await startLane(d, "finishing-task", brief);
  const status = d.sessions.status; let marked = false;
  d.sessions.status = async (id) => {
    if (id === lane.threadId && !marked) { marked = true; await ready(d, lane.key, "verified result", [brief]); return "working"; }
    return status(id);
  };
  await dutyTick(d);
  expect(d.store.lane(lane.key)).toMatchObject({ status: "ready", final: { text: "verified result" } });
});

test("closing an idle thread excludes a concurrent turn submission", async () => {
  const root = home(); const calls: string[] = [];
  const r = new Runtime(root, mock(async (method) => { calls.push(method); return method === "thread/start" ? { thread: { id: "closing-thread" } } : method === "turn/start" ? { turn: { id: "active-turn" } } : {}; }));
  const id = await r.create("fixture", root, "");
  const results = await Promise.allSettled([r.close(id), r.deliver(id, "follow-up", "new-batch")]);
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(calls).not.toContain("turn/start");
});

test("interrupt waits for an in-flight submission before addressing its accepted turn", async () => {
  const root = home(); let release!: (value: unknown) => void; const interrupted: string[] = [];
  const c = mock(async (method, params) => {
    if (method === "thread/start") return { thread: { id: "submitting-thread" } };
    if (method === "turn/start") return await new Promise((resolve) => { release = resolve; });
    if (method === "turn/interrupt") { interrupted.push(params.turnId); c.onMessage({ method: "turn/completed", params: { threadId: params.threadId, turn: { id: params.turnId, status: "interrupted" } } }); }
    return {};
  });
  const r = new Runtime(root, c), id = await r.create("fixture", root, "");
  const delivery = r.deliver(id, "task", "batch"); await Bun.sleep(1);
  let finished = false; const interrupt = r.interrupt(id).then(() => { finished = true; }); await Bun.sleep(1);
  expect(finished).toBe(false); release({ turn: { id: "accepted-turn" } });
  await Promise.all([delivery, interrupt]); expect(interrupted).toEqual(["accepted-turn"]);
});

test("blank messages cannot poison an inbox, including legacy empty batches", async () => {
  const { send, flushInbox } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); const lead = w.addThread("lead"); d.store.setRole("lead", "lead");
  await expect(send(d, "lead", "  \n", "cli")).rejects.toThrow("empty");
  expect(d.store.queued("lead")).toEqual([]);
  d.store.enqueue("lead", { at: 1, from: "old-client", text: "" }); d.store.inboxBatch("lead");
  d.store.enqueue("lead", { at: 2, from: "cli", text: "valid" });
  await flushInbox(d, "lead"); expect(lead.received).toEqual(["valid"]); expect(d.store.queued("lead")).toEqual([]);
});

test("READY cannot close over a queued follow-up or retain stale evidence after it is delivered", async () => {
  const { ready, send, done, flushInbox } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture"); const lane = await startLane(d, "followup-task", brief);
  await ready(d, lane.key, "first result", [brief]); w.threads.get(lane.threadId)!.status = "working";
  expect(await send(d, lane.key, "new required work", "lead")).toBe("QUEUED");
  w.threads.get(lane.threadId)!.status = "idle";
  await expect(done(d, lane.key)).rejects.toThrow("queued");
  await flushInbox(d, lane.threadId);
  expect(d.store.lane(lane.key)?.status).toBe("working"); expect(d.store.lane(lane.key)?.final).toBeUndefined();
  await expect(done(d, lane.key)).rejects.toThrow("not ready");
});

test("closing READY serializes instruction admission and evidence changes across awaited status", async () => {
  const { ready, send, done } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture"); const lane = await startLane(d, "closing-task", brief);
  await ready(d, lane.key, "verified result", [brief]);
  const status = d.sessions.status; let raced = false;
  d.sessions.status = async (id) => {
    if (id === lane.threadId && !raced) {
      raced = true;
      await expect(send(d, lane.key, "follow-up", "lead")).rejects.toThrow("busy");
      await expect(ready(d, lane.key, "changed evidence", [brief])).rejects.toThrow("busy");
      expect(d.store.queued(id)).toEqual([]);
    }
    return status(id);
  };
  await done(d, lane.key);
  expect(d.store.lane(lane.key)).toMatchObject({ status: "done", final: { text: "verified result" } });
  expect(w.threads.has(lane.threadId)).toBe(false);
});

test("acknowledgement-only replay preserves the READY generated by that same batch", async () => {
  const { ready, send, flushInbox } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); w.addThread("lead"); d.store.setRole("lead", "lead");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture"); const lane = await startLane(d, "replay-task", brief);
  const accepted = new Set<string>(); let turns = 0;
  d.sessions.deliver = async (id, _text, batch) => {
    if (id !== lane.threadId || accepted.has(batch!)) return;
    accepted.add(batch!); turns++;
    await ready(d, lane.key, "result from this batch", [brief]);
  };
  const ack = d.store.ackInbox.bind(d.store); let crash = true;
  d.store.ackInbox = (id, count) => {
    if (id === lane.threadId && crash) { crash = false; throw new Error("sender crashed before ack"); }
    ack(id, count);
  };
  await expect(send(d, lane.key, "new work", "lead")).rejects.toThrow("before ack");
  expect(d.store.queued(lane.threadId)).toHaveLength(1);
  await flushInbox(d, lane.threadId);
  expect(turns).toBe(1); expect(d.store.queued(lane.threadId)).toEqual([]);
  expect(d.store.lane(lane.key)).toMatchObject({ status: "ready", final: { text: "result from this batch" } });
});

test("role names and existing thread IDs cannot allocate or queue a lane task", async () => {
  const { backlogAdd } = await import("../src/loop.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root);
  const lead = w.addThread("lead"), duty = w.addThread("duty"); w.addThread("other-thread");
  d.store.setRole("lead", "lead"); d.store.setRole("duty", "duty");
  const brief = join(d.store.root, "brief.md"); writeFileSync(brief, "fixture");
  for (const id of ["lead", "duty", "other-thread"]) {
    await expect(startLane(d, id, brief)).rejects.toThrow("reserved");
    expect(() => backlogAdd(d, id, brief)).toThrow("reserved");
  }
  expect(d.store.lanes()).toEqual([]); expect(d.store.items()).toEqual([]);
  expect(lead.received).toEqual([]); expect(duty.received).toEqual([]);
  expect(w.calls.filter((c) => c.argv[0] === "create")).toHaveLength(0);
});

test("restart preserves a failed turn and cannot close its earlier READY before recovery", async () => {
  const { done } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root); const id = "failed-thread"; let archived = false;
  writeFileSync(join(d.store.root, "sessions", id + ".json"), JSON.stringify({ id, name: "failed-task", cwd: d.store.root, instructions: "", status: "unknown", output: "partial", everStarted: true, lastTurnStatus: "failed" }));
  const r = new Runtime(d.store.root, mock(async (method) => {
    if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
    if (method === "thread/turns/list") return { data: [{ id: "saved-turn", status: "failed" }] };
    if (method === "thread/archive") { archived = true; return {}; }
    if (method === "turn/start") return { turn: { id: "recovery-turn" } };
    return {};
  }));
  d.store.saveLane({ key: "failed-task", threadId: id, cwd: d.store.root, brief: "fixture", status: "ready", createdAt: 1, lastActivityAt: 1, nudges: 0, log: [], final: { at: 1, text: "stale", evidence: ["fixture"] } });
  d.sessions.status = (thread) => r.status(thread); d.sessions.close = (thread) => r.close(thread);
  expect(await r.status(id)).toBe("failed");
  await expect(done(d, "failed-task")).rejects.toThrow("failed"); expect(archived).toBe(false);
  await r.deliver(id, "recover explicitly"); expect(r.sessions.get(id)?.lastTurnStatus).toBeUndefined();
});

test("reconciliation resumes unloaded saved threads before verifying idle, without starting work", async () => {
  for (const { delivered, failed } of [{ delivered: true, failed: false }, { delivered: false, failed: false }, { delivered: true, failed: true }]) {
    const root = home(); mkdirSync(join(root, "sessions")); const calls: string[] = []; let loaded = false;
    writeFileSync(join(root, "sessions/pending-thread.json"), JSON.stringify({ id: "pending-thread", name: "pending", cwd: root, instructions: "", status: "unknown", output: "", everStarted: true, uncertainDelivery: true, pendingDeliveryId: "saved-batch", lastTurnStatus: failed ? "failed" : undefined }));
    const r = new Runtime(root, mock(async (method) => {
      calls.push(method);
      if (method === "thread/resume") { loaded = true; return { thread: { status: { type: "idle" } } }; }
      if (method === "thread/turns/list") return { data: [{ id: "saved-turn", status: failed ? "failed" : "completed" }] };
      if (method === "thread/read") return { thread: { status: { type: loaded ? "idle" : "notLoaded" } } };
      return {};
    }));
    await r.reconcile("pending-thread", delivered);
    expect(calls).toEqual(["thread/resume", "thread/turns/list", "thread/read"]);
    expect(r.sessions.get("pending-thread")).toMatchObject({ status: failed ? "failed" : "idle", uncertainDelivery: false });
    expect(r.sessions.get("pending-thread")?.lastDeliveryId).toBe(delivered ? "saved-batch" : undefined);
  }
});

test("a missed terminal event is recovered from server history, while missing or unrelated outcomes require recovery", async () => {
  const { done } = await import("../src/harness.ts");
  for (const outcome of ["failed", "inProgress", "missing", "unrelated"] as const) {
    const w = new World(), d = w.deps(); homes.push(d.store.root); const id = "lost-event-thread"; let archived = false, starts = 0;
    writeFileSync(join(d.store.root, "sessions", id + ".json"), JSON.stringify({ id, name: "lost-event", cwd: d.store.root, instructions: "", status: "working", output: "partial", everStarted: true, turnId: "saved-turn" }));
    const r = new Runtime(d.store.root, mock(async (method) => {
      if (method === "thread/resume") return { thread: { status: { type: "idle" } } };
      if (method === "thread/turns/list") return { data: outcome === "missing" ? [] : [{ id: outcome === "unrelated" ? "other-turn" : "saved-turn", status: outcome === "unrelated" ? "completed" : outcome }] };
      if (method === "thread/archive") { archived = true; return {}; }
      if (method === "turn/start") { starts++; return { turn: { id: "recovery-turn" } }; }
      return {};
    }));
    d.store.saveLane({ key: "lost-event", threadId: id, cwd: d.store.root, brief: "fixture", status: "ready", createdAt: 1, lastActivityAt: 1, nudges: 0, log: [], final: { at: 1, text: "premature", evidence: ["fixture"] } });
    d.sessions.status = (thread) => r.status(thread); d.sessions.close = (thread) => r.close(thread);
    expect(await r.status(id)).toBe(outcome === "failed" ? "failed" : "recovery");
    await expect(done(d, "lost-event")).rejects.toThrow("recover"); expect(archived).toBe(false); expect(starts).toBe(0);
    await r.deliver(id, "inspect and recover explicitly", "new-instructions"); expect(starts).toBe(1);
  }
});

test("duty preserves underscore and colon thread IDs without inbox aliasing", async () => {
  const { send, dutyTick } = await import("../src/harness.ts");
  const w = new World(), d = w.deps(); homes.push(d.store.root);
  const underscore = w.addThread("thr_123", "working"), colon = w.addThread("thr:123", "working");
  await send(d, "thr_123", "underscore work", "cli"); await send(d, "thr:123", "colon work", "cli");
  expect(d.store.inboxThreads().sort()).toEqual(["thr:123", "thr_123"]);
  underscore.status = "idle"; colon.status = "idle"; await dutyTick(d);
  expect(underscore.received).toEqual(["underscore work"]); expect(colon.received).toEqual(["colon work"]);
  expect(d.store.inboxThreads()).toEqual([]);
});
