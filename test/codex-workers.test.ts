import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { startWorker } from "../src/runtime/codex/workers.ts";
import { fixture } from "./codex-fixture.test.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.each(["identity", "missing", "persist"] as const)(
  "post-spawn %s failure terminates and reaps the owned worker group",
  async (stage) => {
    const f = await fixture();
    const ref = await f.rt.create({ ...f.spec, role: "hourly-loop" });
    const store = new CodexStore(f.root);
    const entry = await store.owned(ref);
    const childPath = join(store.directory, "spawned-child");
    const ready = Promise.withResolvers<void>();
    const watcher = watch(store.directory, (_event, name) => {
      if (name === "spawned-child") ready.resolve();
    });
    const script = `printf '%s' "$$" > ${quote(`${childPath}.tmp`)}; /bin/mv ${quote(`${childPath}.tmp`)} ${quote(childPath)}; exec /bin/sleep 30`;
    const command = `/bin/sh -c ${quote(script)}`;
    const host = { ...f.rt.prepareHost(f.spec.cwd), command };
    const spawned = spyOn(childProcess, "spawn");
    const failure = Object.assign(new Error(`${stage} failure`), { code: stage === "persist" ? "ENOSPC" : "EIO" });
    const originalSpawn = Bun.spawn;
    const probe = spyOn(Bun, "spawn");
    const save = spyOn(store, "save");
    if (stage === "identity")
      probe.mockImplementationOnce(originalSpawn).mockImplementationOnce(() => {
        throw failure;
      });
    else if (stage === "missing")
      probe
        .mockImplementationOnce(originalSpawn)
        .mockImplementationOnce(() =>
          originalSpawn(["/usr/bin/false"], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
        );
    else
      save.mockImplementationOnce(async () => {
        await ready.promise;
        throw failure;
      });
    f.cleanup.push(async () => {
      watcher.close();
      const result = spawned.mock.results[0];
      spawned.mockRestore();
      probe.mockRestore();
      save.mockRestore();
      if (result?.type !== "return" || !result.value.pid) return;
      const child = result.value;
      const reaped =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        process.kill(-result.value.pid, "SIGKILL");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
      await reaped;
    });

    const startup = startWorker(store, entry, `${command} loop`, f.env, host);
    if (stage === "missing") await expect(startup).rejects.toMatchObject({ kind: "ownership" });
    else await expect(startup).rejects.toBe(failure);

    const result = spawned.mock.results[0];
    if (result?.type !== "return") throw new TypeError("Expected the owned worker to spawn");
    let descendantRunning = false;
    if (stage === "persist") {
      const pid = (await Bun.file(childPath).text()).trim();
      const status = Bun.spawn(["/bin/ps", "-p", pid, "-o", "stat="], {
        env: process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const state = (await new Response(status.stdout).text()).trim();
      await status.exited;
      descendantRunning = state !== "" && !state.startsWith("Z");
    }
    expect({
      reaped: result.value.exitCode !== null || result.value.signalCode !== null,
      descendantRunning,
    }).toEqual({ reaped: true, descendantRunning: false });
  },
);

test("loop workers preserve scoped env and persisted output and close their own process group", async () => {
  const f = await fixture();
  const ref = await f.rt.create({
    ...f.spec,
    role: "hourly-loop",
    env: { ...f.spec.env, WORKER_VALUE: "owned-value" },
  });
  const ready = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const watcher = watch(join(f.root, "codex", "sessions"), (_event, name) => {
    if (name === "ready") ready.resolve();
    if (name === "terminated") stopped.resolve();
  });
  f.cleanup.push(async () => {
    watcher.close();
    await f.rt.close(ref);
  });
  const script = `trap 'printf done > ${quote(join(f.root, "codex", "sessions", "terminated"))}; exit 0' TERM; printf '%s %s %s\\n' "$WORKER_VALUE" "$DORI_HOME" "$DORI_CODEX_WORKER"; printf ready > ${quote(join(f.root, "codex", "sessions", "ready"))}; while :; do /bin/sleep 10; done`;

  const command = `/bin/sh -c ${quote(script)}`;
  await expect(f.rt.start(ref, `${command} loop`)).rejects.toMatchObject({ kind: "unsupported" });
  // Exercise process supervision with an explicit trusted test executable; native startup forbids arbitrary commands.
  const store = new CodexStore(f.root);
  await startWorker(store, await store.owned(ref), `${command} loop`, f.env, {
    ...f.rt.prepareHost(f.spec.cwd),
    command,
  });
  await ready.promise;
  const restored = new CodexRuntime(f.root, f.env);

  expect((await restored.probe(ref)).status).toBe("working");
  expect(await restored.read(ref, 10)).toBe(`owned-value ${f.root} ${ref.id}\n`);
  await restored.close(ref);
  await stopped.promise;
  expect((await restored.probe(ref)).status).toBe("gone");
  expect(f.calls).toEqual([]);
});

test("a persisted worker PID without its recorded birth identity is never signalled", async () => {
  const f = await fixture();
  const ref = await f.rt.create({ ...f.spec, role: "hourly-loop" });
  const path = join(f.root, "codex", "sessions", `${ref.id}.json`);
  const entry = object(await Bun.file(path).json());
  await Bun.write(path, JSON.stringify({ ...entry, pid: process.pid, birth: "not-this-process" }));

  expect((await f.rt.probe(ref)).status).toBe("gone");
  await f.rt.close(ref);

  expect((await f.rt.probe(ref)).status).toBe("gone");
});
