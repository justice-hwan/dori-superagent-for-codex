import { expect, onTestFinished, test } from "bun:test";
import { up } from "../src/cli-up.ts";
import { deliver } from "../src/runtime/codex/delivery.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import type { CreateSpec, Probe, SessionRef } from "../src/runtime/types.ts";
import { harnessFixture } from "./codex-fixture.test.ts";
import { takeInboxLock } from "../src/inbox-lock.ts";

test("close cannot race an admitted submission and restore released ownership", async () => {
  const { f } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class PausedConnection extends CodexConnection {
    override async call(method: string, params: Record<string, unknown>): Promise<unknown> {
      const result = await super.call(method, params);
      if (method === "turn/start") {
        entered.resolve();
        await release.promise;
      }
      return result;
    }
  }
  const connection = new PausedConnection(f.env.DORI_CODEX_SOCKET);
  onTestFinished(() => connection.disconnect());
  const pending = deliver(new CodexStore(f.root), connection, ref, "bounded task");
  await entered.promise;
  const result = await f.rt.close(ref).then(
    () => undefined,
    (error: unknown) => error,
  );
  release.resolve();
  await pending;

  expect(result).toMatchObject({ kind: "unsupported" });
  await f.rt.close(ref);
  expect((await new CodexRuntime(f.root, f.env).probe(ref)).status).toBe("gone");
});

test("concurrent native up creates one complete role set without orphaned registrations", async () => {
  const { f, d } = await harnessFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  class PausedRuntime extends CodexRuntime {
    readonly opened: SessionRef[] = [];
    readonly workers = new Set<string>();
    private paused = false;
    override async create(spec: CreateSpec): Promise<SessionRef> {
      if (spec.role === "lead" && !this.paused) {
        this.paused = true;
        entered.resolve();
        await release.promise;
      }
      const ref = await super.create(spec);
      this.opened.push(ref);
      return ref;
    }
    override async start(ref: SessionRef): Promise<void> {
      this.workers.add(ref.id);
    }
    override async probe(ref: SessionRef): Promise<Probe> {
      return ref.id.startsWith("worker-")
        ? { status: this.workers.has(ref.id) ? "working" : "gone", shellInFront: false }
        : super.probe(ref);
    }
  }
  const runtime = new PausedRuntime(f.root, f.env);
  const scoped = { ...d, runtimes: new Runtimes("codex", () => runtime) };
  const first = up(scoped, f.root);
  await entered.promise;
  const result = await up(scoped, f.root).then(
    () => undefined,
    (error: unknown) => error,
  );
  release.resolve();
  await first;

  expect(result).toBeInstanceOf(Error);
  expect(result instanceof Error ? result.message : "").toContain("startup");
  expect(runtime.opened).toHaveLength(4);
  expect(new Set(Object.values(d.store.roles()).map((ref) => ref.id))).toEqual(
    new Set(runtime.opened.map((ref) => ref.id)),
  );
});

test("worker startup honors the ownership submission mutex before spawning", async () => {
  const { f } = await harnessFixture();
  const worker = await f.rt.create({ ...f.spec, role: "duty-loop" });
  const store = new CodexStore(f.root);
  const release = takeInboxLock(`${store.path(worker.id)}.submit-lock`, Date.now());
  if (!release) throw new TypeError("Missing ownership lock");
  let result: unknown;
  try {
    result = await f.rt.start(worker, `'${process.execPath}' -e 'process.exit(0)' duty --interval 60`).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    release();
    await f.rt.close(worker);
  }
  expect(result).toMatchObject({ kind: "unsupported", message: "A submission is still in progress" });
});
