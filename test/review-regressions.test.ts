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
    return {};
  });
  const r = new Runtime(root, c); expect(await r.status("resume-thread")).toBe("idle");
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
