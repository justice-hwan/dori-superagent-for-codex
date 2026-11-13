import { expect, test } from "bun:test";
import { watch } from "node:fs";
import { join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { startWorker } from "../src/runtime/codex/workers.ts";
import { fixture } from "./codex-fixture.test.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

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
