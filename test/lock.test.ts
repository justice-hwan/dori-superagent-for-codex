import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileLease } from "../src/lock.ts";

test("a stale lock has at most one concurrent owner across processes", async () => {
  const root = mkdtempSync(join(tmpdir(), "dori-lease-test-")), lock = join(root, "lock"), marker = join(root, "critical");
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, nonce: "dead" }));
  try {
    const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/lock-worker.ts"), lock, marker], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    expect(results).toEqual(results.map(() => ({ code: 0, err: "" })));
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a claim gate is preserved for inspection and a release cannot remove a different owner", () => {
  const root = mkdtempSync(join(tmpdir(), "dori-lease-test-")), lock = join(root, "lock");
  try {
    writeFileSync(lock + ".claim", JSON.stringify({ pid: 2147483647, nonce: "inspect" }));
    expect(acquireFileLease(lock)).toBeUndefined(); expect(existsSync(lock + ".claim")).toBe(true);
    rmSync(lock + ".claim"); const lease = acquireFileLease(lock)!;
    writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "new-owner" }));
    lease.release(); expect(JSON.parse(readFileSync(lock, "utf8")).nonce).toBe("new-owner");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("three concurrent stale loop reclaimers cannot overlap task admission", async () => {
  const { Store } = await import("../src/store.ts");
  const { readdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "dori-loop-lease-")), store = new Store(root);
  try {
    store.setRole("lead", "lead-thread");
    for (const id of ["task-one", "task-two", "task-three"]) {
      const brief = store.itemBrief(id); writeFileSync(brief, "fixture");
      store.saveItem({ id, title: id, brief, cwd: root, priority: 5, status: "open", attempts: 0, createdAt: 1, updatedAt: 1, log: [] });
    }
    writeFileSync(store.loopPath("lock"), JSON.stringify({ pid: 2147483647, nonce: "dead" }));
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/loop-worker.ts"), root], { stdout: "pipe", stderr: "pipe" }));
    const deadline = Date.now() + 5000;
    while (readdirSync(root).filter(f => f.startsWith("ready-")).length < 3) { if (Date.now() > deadline) throw new Error("workers did not start"); await Bun.sleep(5); }
    writeFileSync(join(root, "go"), "go");
    const results = await Promise.all(children.map(async p => ({ code: await p.exited, err: await new Response(p.stderr).text(), run: JSON.parse(await new Response(p.stdout).text()) })));
    expect(results.map(r => ({ code: r.code, err: r.err }))).toEqual(results.map(() => ({ code: 0, err: "" })));
    expect(results.flatMap(r => r.run.started)).toHaveLength(1);
    expect(readFileSync(join(root, "starts"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(root, "critical"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 10_000);
