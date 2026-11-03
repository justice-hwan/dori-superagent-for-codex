import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Codex } from "../src/codex.ts";
import { Runtime, type Session } from "../src/runtime.ts";
import { Store } from "../src/store.ts";
import { send, flushInbox } from "../src/harness.ts";
import { World } from "./fake.ts";
const fixtures: { home: string; runtime: Runtime }[] = [];
afterEach(async () => { const all = fixtures.splice(0); for (const { runtime } of all) await runtime.shutdown(); for (const home of new Set(all.map((f) => f.home))) rmSync(home, { recursive: true, force: true }); });
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "dori-rpc-test-"));
  const runtime = new Runtime(home, new Codex([process.execPath, join(import.meta.dir, "fixtures/fake-codex.ts")]));
  fixtures.push({ home, runtime }); await runtime.codex.connect(); return { home, runtime };
}
async function until(fn: () => boolean) { const end = Date.now() + 2000; while (!fn()) { if (Date.now() > end) throw new Error("fixture timed out"); await Bun.sleep(5); } }

test("real stdio JSON-RPC: create, stream, complete, archive and restrict ownership", async () => {
  const { home, runtime: r } = await setup();
  const id = await r.create("sample", home, "fixture", undefined, true);
  await r.deliver(id, "marker"); await until(() => r.sessions.get(id)?.status === "done");
  expect(r.sessions.get(id)).toMatchObject({ output: "marker", lastTurnStatus: "completed", readOnly: true });
  expect(statSync(join(home, "sessions", id + ".json")).mode & 0o777).toBe(0o600);
  await expect(r.deliver("not-owned", "x")).rejects.toThrow("not an open Dori-owned");
  await r.close(id); expect(await r.status(id)).toBe("gone");
});

test("busy threads reject input; an identical submitted delivery ID is not replayed", async () => {
  const { home, runtime: r } = await setup(); const id = await r.create("sample", home, "fixture");
  await r.deliver(id, "HOLD", "batch-one"); const turn = r.sessions.get(id)?.turnId;
  await r.deliver(id, "HOLD", "batch-one"); expect(r.sessions.get(id)?.turnId).toBe(turn);
  await expect(r.deliver(id, "another", "batch-two")).rejects.toThrow("working");
  await r.interrupt(id); await until(() => r.sessions.get(id)?.status === "idle");
  expect(r.sessions.get(id)?.lastTurnStatus).toBe("interrupted");
});

test("approval requests block until an explicit response, and stale responses are refused", async () => {
  const { home, runtime: r } = await setup(); const id = await r.create("sample", home, "fixture");
  await r.deliver(id, "APPROVE"); await until(() => r.requests.size === 1);
  expect(await r.status(id)).toBe("blocked");
  expect(JSON.parse(readFileSync(join(home, "requests.json"), "utf8"))).toHaveLength(1);
  await r.answer("approval-1", { decision: "decline" });
  await until(() => r.sessions.get(id)?.status === "done");
  await expect(r.answer("approval-1", { decision: "accept" })).rejects.toThrow("no longer pending");
});

test("failed turns are not success, and a disconnect rejects pending requests promptly", async () => {
  const { home, runtime: r } = await setup(); const id = await r.create("sample", home, "fixture");
  await r.deliver(id, "FAIL"); await until(() => r.sessions.get(id)?.lastTurnStatus === "failed");
  expect(await r.status(id)).toBe("unknown");
  const second = await r.create("sample2", home, "fixture");
  await expect(r.deliver(second, "DROP")).rejects.toThrow("disconnected");
  expect(r.sessions.get(second)?.uncertainDelivery).toBe(true);
});

test("restart resumes used threads, replaces only empty missing threads, and retains uncertain delivery", async () => {
  const { home, runtime: r } = await setup();
  const base: Session = { id: "used-thread", name: "test", cwd: home, instructions: "fixture", status: "unknown", output: "marker", everStarted: true };
  for (const s of [base, { ...base, id: "empty-thread", output: "", everStarted: false }, { ...base, id: "uncertain-thread", uncertainDelivery: true }, { ...base, id: "missing-used" }]) {
    writeFileSync(join(home, "sessions", s.id + ".json"), JSON.stringify(s));
  }
  await r.shutdown();
  const restarted = new Runtime(home, new Codex([process.execPath, join(import.meta.dir, "fixtures/fake-codex.ts")]));
  fixtures.push({ home, runtime: restarted });
  await restarted.codex.connect();
  expect(await restarted.status("used-thread")).toBe("idle");
  expect(await restarted.status("empty-thread")).toBe("gone");
  expect(await restarted.status("uncertain-thread")).toBe("unknown");
  await expect(restarted.status("missing-used")).rejects.toThrow("no rollout");
  await restarted.reconcile("uncertain-thread", false); expect(await restarted.status("uncertain-thread")).toBe("idle");
  await restarted.shutdown();
});

test("queue batch survives concurrent append and prevents simultaneous submissions", async () => {
  const w = new World(), d = w.deps(); w.addThread("lead"); d.store.setRole("lead", "lead");
  let release!: () => void; let submitted!: () => void;
  const started = new Promise<void>((r) => { submitted = r; });
  const held = new Promise<void>((r) => { release = r; });
  const original = d.sessions.deliver;
  d.sessions.deliver = async (...args) => { submitted(); await held; await original(...args); };
  const first = send(d, "lead", "first", "cli"); await started;
  expect(await send(d, "lead", "second", "cli")).toBe("QUEUED");
  release(); expect(await first).toBe("DELIVERED");
  expect(d.store.queued("lead").map((m) => m.text)).toEqual(["second"]);
  await flushInbox(d, "lead"); expect(w.threads.get("lead")?.received).toEqual(["first", "second"]);
});

test("inbox acknowledgment is idempotent after a crash between cursor commit and batch removal", () => {
  const home = mkdtempSync(join(tmpdir(), "dori-inbox-test-")); const s = new Store(home);
  try {
    s.enqueue("lead", { at: 1, from: "cli", text: "first" }); const batch = s.inboxBatch("lead")!;
    const journal = join(home, "inbox/lead.jsonl"); writeFileSync(journal + ".cursor", "1");
    s.enqueue("lead", { at: 2, from: "cli", text: "second" });
    expect(s.inboxBatch("lead")?.id).toBe(batch.id); s.ackInbox("lead", 1);
    expect(s.queued("lead").map((m) => m.text)).toEqual(["second"]);
    expect(existsSync(journal + ".batch")).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("disconnect verifies exit of its own stubborn child after bounded escalation", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-stubborn-test-")), pidFile = join(home, "pid");
  const codex = new Codex([process.execPath, join(import.meta.dir, "fixtures/stubborn-codex.ts"), pidFile]);
  let pid: number | undefined;
  try {
    await codex.connect(); pid = Number(readFileSync(pidFile, "utf8")); await codex.disconnect();
    let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
    expect(alive).toBe(false);
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await codex.disconnect(); rmSync(home, { recursive: true, force: true });
  }
}, 8000);

test("disconnect also stops helpers in its isolated app-server process group", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-owned-group-test-")), pidFile = join(home, "pids");
  const codex = new Codex([process.execPath, join(import.meta.dir, "fixtures/codex-with-helper.ts"), pidFile]);
  let helper: number | undefined;
  try {
    await codex.connect(); helper = JSON.parse(readFileSync(pidFile, "utf8")).helper;
    await codex.disconnect();
    const result = Bun.spawnSync(["ps", "-p", String(helper), "-o", "stat="]);
    const state = result.stdout.toString().trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally {
    if (helper) { try { process.kill(helper, "SIGKILL"); } catch {} }
    await codex.disconnect(); rmSync(home, { recursive: true, force: true });
  }
}, 8000);
