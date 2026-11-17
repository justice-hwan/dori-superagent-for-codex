import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { nativeGuard, nativeHostStatus } from "../src/native-guard.ts";
import { nativeUp } from "../src/native-host.ts";
import { nativeSetup } from "./native-setup.ts";
import { nativeDeps } from "./native-deps.ts";

function host(f: ReturnType<typeof nativeSetup>) {
  const child = f.spawn("up");
  const ready = Promise.withResolvers<void>();
  const stream = Readable.from(child.stdout);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const output: string[] = [];
  const pump = (async () => {
    try {
      for await (const line of lines) {
        output.push(line);
        if (line.startsWith("UP runtime=codex ")) ready.resolve();
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  })();
  const finished = Promise.all([child.exited, pump, new Response(child.stderr).text()]).then(([code, , stderr]) => ({
    code,
    stderr,
    stdout: output.join("\n"),
  }));
  const started = Promise.race([
    ready.promise,
    finished.then((r) => {
      throw new Error(`native host exited before UP: ${r.stderr}`);
    }),
  ]);
  const stop = async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    return finished;
  };
  return { child, started, finished, stop };
}

test("one OS-backed native host owns the original loops, reports real status, joins shutdown and reuses accepted roles", async () => {
  const f = nativeSetup();
  const first = host(f);
  try {
    await first.started;
    const status = await f.run("status");
    expect(status.stdout).toContain(`HOST running pid=${first.child.pid}`);
    expect(status.stdout).toContain("duty=running hourly=running");
    const roles = JSON.parse(readFileSync(join(f.home, "roles.json"), "utf8"));
    expect(Object.keys(roles).sort()).toEqual(["duty", "lead"]);
    expect(Object.values(roles).every((value) => typeof value === "string" && value.startsWith("codex:"))).toBe(true);
    expect(f.threads.size).toBe(2);
    const second = await f.run("up");
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("guard unavailable");
    expect(f.threads.size).toBe(2);
  } finally {
    expect((await first.stop()).code).toBe(0);
  }
  expect(existsSync(join(f.home, "duty", "lock"))).toBe(false);
  expect(existsSync(join(f.home, "loop", "lock"))).toBe(false);
  expect((await f.run("status")).stdout).toContain("HOST stopped");
  expect([...f.threads.values()].some((thread) => thread.archived)).toBe(false);
  const bootstraps = f.queued.slice(0, 2).map((q) => JSON.stringify(q["input"]));
  expect(new Set(bootstraps).size).toBe(2);
  const restarted = host(f);
  try {
    await restarted.started;
    expect(f.threads.size).toBe(2);
    expect(f.queued.filter((q) => bootstraps.includes(JSON.stringify(q["input"])))).toHaveLength(2);
  } finally {
    await restarted.stop();
  }
});

test("pause files remain pause controls without pretending the loop processes are Codex refs", async () => {
  const f = nativeSetup();
  const { d } = nativeDeps(f);
  d.store.setStop(Date.now(), "pause", "duty");
  d.store.setStop(Date.now(), "pause");
  const running = host(f);
  try {
    await running.started;
    const status = await f.run("status");
    expect(status.stdout).toContain("duty=paused hourly=paused");
    expect(f.threads.size).toBe(2);
    expect(f.queued).toHaveLength(2);
    expect(JSON.stringify(f.queued)).not.toContain("FORBIDDEN-OMO");
  } finally {
    await running.stop();
  }
});

test("a runner failure retains the OS guard until the other original runner's in-flight I/O is joined", async () => {
  const f = nativeSetup("hold-loop");
  const { d } = nativeDeps(f);
  const broken = {
    ...d,
    usage: {
      ...d.usage,
      duty: () => {
        throw new Error("duty failure");
      },
    },
  };
  const finished = nativeUp(broken, f.cwd).then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.race([
    f.waitQueued(3),
    finished.then((error) => {
      throw error ?? new Error("host returned before in-flight I/O");
    }),
  ]);
  try {
    expect(await nativeHostStatus(f.home)).toContain("HOST stopping");
    await expect(nativeGuard(f.home, "host")).rejects.toThrow("guard unavailable");
  } finally {
    f.releaseQueued();
  }
  const error = await finished;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toContain("duty failure");
  expect(existsSync(join(f.home, "duty", "lock"))).toBe(false);
  expect(existsSync(join(f.home, "loop", "lock"))).toBe(false);
  const next = await nativeGuard(f.home, "host");
  await next[Symbol.asyncDispose]();
  expect([...f.threads.values()].some((thread) => thread.archived)).toBe(false);
});

test("a live original duty lock blocks native startup before any irreversible creation", async () => {
  const f = nativeSetup();
  const { d } = nativeDeps(f);
  writeFileSync(d.store.lockPath("duty"), JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "other-runner" }));
  const result = await f.run("up");
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("another duty runner");
  expect(f.threads.size).toBe(0);
  expect(f.calls).toHaveLength(0);
});
