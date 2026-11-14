import { expect, onTestFinished, test } from "bun:test";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexError, object } from "../src/runtime/codex/protocol.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { fixture } from "./codex-fixture.test.ts";

test("native startup initializes and restores paginated completed history through a fresh client", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const prompt = "literal $(touch /tmp/must-not-run) ' ;\nsecond line";

  await f.rt.startAgent(ref, { prompt, systemPrompt: "Role instructions" });
  f.finish(ref.id, "first complete answer");
  await f.rt.deliver(ref, "follow-up");
  f.finish(ref.id, "second complete answer");

  const restored = new CodexRuntime(f.root, f.env);
  expect(await restored.read(ref, 30)).toBe(
    `user: ${prompt}\nassistant: first complete answer\nuser: follow-up\nassistant: second complete answer`,
  );
  const policy = object(object(f.params()["config"])["shell_environment_policy"]);
  expect(object(policy["set"])).toMatchObject({ DORI_HOME: f.root, DORI_LANE: "lane one", TEST_VALUE: "scoped" });
  expect(f.params()).toMatchObject({ model: "gpt-6.1-sol", sandbox: "workspace-write", approvalPolicy: "on-request" });
  expect(f.threads.get(ref.id)?.name).toBe("Dori lane: lane");
});

test("a native naming failure retains ownership for recovery", async () => {
  const f = await fixture();
  f.failNaming();

  const error = await f.rt.create(f.spec).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(error).toMatchObject({ kind: "remote" });
  const owned = await f.rt.list();
  expect(owned.map((session) => session.ref.id)).toEqual([...f.threads.keys()]);
});

test.each([
  { status: { type: "active", activeFlags: [] }, expected: "working" },
  { status: { type: "active", activeFlags: ["waitingOnApproval"] }, expected: "blocked" },
  { status: { type: "active", activeFlags: ["waitingOnUserInput"] }, expected: "blocked" },
  { status: { type: "systemError" }, expected: "error" },
])("does not steer or answer desktop state $expected even when forced", async ({ status, expected }) => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("Missing thread");
  thread.status = status;

  expect(await f.rt.deliver(ref, "Do not send", { force: true, when: "any" })).toEqual({
    kind: "not-ready",
    status: expected,
  });
  expect(f.calls.filter((method) => method === "turn/start")).toEqual([]);
  expect(thread.status).toEqual(status);
});

test("remote rejection throws and permits a corrected submission", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  f.admission("reject");

  const error = await f.rt.deliver(ref, "rejected").then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(error).toBeInstanceOf(CodexError);
  expect(error).toMatchObject({ kind: "remote", code: -32602 });
  f.admission("accept");
  expect(await f.rt.deliver(ref, "corrected")).toEqual({ kind: "delivered", started: true });
});

test.each(["disconnect", "malformed"] as const)(
  "persists uncertain admission after %s and never automatically resubmits",
  async (failure) => {
    const f = await fixture();
    const ref = await f.rt.create(f.spec);
    f.admission(failure);

    expect((await f.rt.deliver(ref, "possibly accepted")).kind).toBe("ambiguous");
    const restored = new CodexRuntime(f.root, f.env);
    f.admission("accept");
    expect((await restored.deliver(ref, "must remain held")).kind).toBe("ambiguous");
    expect(f.calls.filter((method) => method === "turn/start")).toEqual(["turn/start"]);
  },
);

test("ownership refusal covers reading, delivery, shell operations and close in a different home", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const other = new CodexRuntime(join(f.root, "other"), f.env);
  const before = [...f.calls];

  for (const operation of [
    () => other.probe(ref),
    () => other.read(ref, 10),
    () => other.deliver(ref, "x"),
    () => other.close(ref),
    () => other.start(ref, "dori loop"),
    () => other.startAgent(ref, { prompt: "x" }),
    () => other.keys(ref, ["escape"]),
    () => other.typeIntoShell(ref, "x"),
    () => other.submitTyped(ref, {}),
  ]) {
    const error = await operation().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ kind: "ownership" });
  }
  expect(f.calls).toEqual(before);
});

test("closing an owned thread unsubscribes without changing active desktop work or history", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  await f.rt.deliver(ref, "desktop-visible history");

  await f.rt.close(ref);

  expect((await f.rt.probe(ref)).status).toBe("gone");
  expect(f.threads.get(ref.id)?.status.type).toBe("active");
  expect(f.threads.get(ref.id)?.items).toHaveLength(1);
  expect(f.calls.filter((method) => /archive|delete|interrupt|unsubscribe/.test(method))).toEqual([
    "thread/unsubscribe",
  ]);
});

test("idle watch discovers new owned threads and sees an inbox write after completion", async () => {
  const f = await fixture();
  let notify = Promise.withResolvers<SessionRef>();
  const stop = await f.rt.watchIdle(async (ref) => {
    notify.resolve(ref);
  });
  onTestFinished(stop);
  const other = new CodexRuntime(f.root, f.env);

  const ref = await other.create(f.spec);
  expect((await notify.promise).id).toBe(ref.id);
  await other.deliver(ref, "first");
  notify = Promise.withResolvers<SessionRef>();
  f.finish(ref.id, "complete");
  expect((await notify.promise).id).toBe(ref.id);
  notify = Promise.withResolvers<SessionRef>();
  await mkdir(join(f.root, "inbox"), { recursive: true });
  await appendFile(join(f.root, "inbox", `codex--${ref.id}.jsonl`), '{"text":"late message"}\n');
  expect((await notify.promise).id).toBe(ref.id);
  notify = Promise.withResolvers<SessionRef>();
  await appendFile(join(f.root, "inbox", `codex--${ref.id}.jsonl`), '{"text":"existing file append"}\n');
  expect((await notify.promise).id).toBe(ref.id);
  stop();
});

test("a slow idle callback does not serialize unrelated threads", async () => {
  const f = await fixture();
  const a = await f.rt.create(f.spec);
  const b = await f.rt.create(f.spec);
  await f.rt.deliver(a, "A");
  await f.rt.deliver(b, "B");
  const release = Promise.withResolvers<void>();
  const observed = Promise.withResolvers<void>();
  const stop = await f.rt.watchIdle(async (ref) => {
    if (ref.id === a.id) await release.promise;
    if (ref.id === b.id) observed.resolve();
  });
  onTestFinished(stop);

  f.finish(a.id, "A finished");
  f.finish(b.id, "B finished");

  await observed.promise;
  release.resolve();
  stop();
});
