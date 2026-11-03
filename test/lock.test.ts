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
