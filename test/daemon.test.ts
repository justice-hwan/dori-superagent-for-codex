import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureRuntime } from "../src/daemon.ts";
import { socketPath } from "../src/sessions.ts";

test("a stopping runtime is never reported ready and never causes another daemon to spawn", async () => {
  const home = mkdtempSync(join(tmpdir(), "dori-stopping-test-")), path = socketPath(home);
  const server = Bun.serve({ unix: path, fetch: () => Response.json({ value: { pid: process.pid, stopping: true, shutdownError: "fixture shutdown unconfirmed" } }) });
  try {
    await expect(ensureRuntime(home)).rejects.toThrow("runtime is stopping");
    expect(existsSync(join(home, "runtime.log"))).toBe(false);
    expect(existsSync(join(home, "runtime.lock"))).toBe(false);
  } finally { server.stop(true); if (existsSync(path)) unlinkSync(path); rmSync(home, { recursive: true, force: true }); }
});
