import { expect, onTestFinished, test } from "bun:test";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { fixture } from "./codex-fixture.test.ts";

test("explicit recovery clears uncertain admission while ordinary retries keep it held", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  f.admission("disconnect");
  await f.rt.deliver(ref, "uncertain");
  f.admission("accept");
  f.finish(ref.id, "original submission confirmed");

  await f.rt.resolveDelivery(ref);

  expect(await f.rt.deliver(ref, "operator authorized resend")).toEqual({ kind: "delivered", started: true });
});

test("desktop handoff persists across clients and takeback requires an idle thread", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  await f.rt.handoff(ref, true);
  const restored = new CodexRuntime(f.root, f.env);
  expect(await restored.deliver(ref, "held while desktop owns it", { force: true })).toEqual({
    kind: "not-ready",
    status: "blocked",
  });
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("Missing fixture thread");
  thread.status = { type: "active", activeFlags: ["waitingOnApproval"] };
  const error = await restored.handoff(ref, false).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ kind: "unsupported" });

  thread.status = { type: "idle" };
  await restored.handoff(ref, false);

  expect(await restored.deliver(ref, "resumed harness")).toEqual({ kind: "delivered", started: true });
});

test("idle watcher rejoins owned subscriptions after transport loss without replaying turns", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  await f.rt.deliver(ref, "one admitted turn");
  const completed = Promise.withResolvers<SessionRef>();
  const stop = await f.rt.watchIdle(async (ref) => {
    completed.resolve(ref);
  });
  onTestFinished(stop);
  const rejoined = f.nextResume();

  f.dropClients();
  expect(await rejoined).toBe(ref.id);
  f.finish(ref.id, "after reconnect");

  expect((await completed.promise).id).toBe(ref.id);
  expect(f.calls.filter((method) => method === "turn/start")).toEqual(["turn/start"]);
  stop();
});

test("an owned durable thread that is not loaded resumes before a fresh client's delivery", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("Missing fixture thread");
  thread.status = { type: "notLoaded" };
  const restored = new CodexRuntime(f.root, f.env);

  expect(await restored.deliver(ref, "after restart")).toEqual({ kind: "delivered", started: true });
  expect(f.calls.filter((method) => method === "thread/resume")).toEqual(["thread/resume"]);
});

test("an owned durable thread that was actually removed reports gone and refuses delivery", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  f.threads.delete(ref.id);

  expect((await f.rt.probe(ref)).status).toBe("gone");
  expect(await f.rt.deliver(ref, "not submitted")).toEqual({ kind: "not-ready", status: "gone" });
});

test("sequential uncertain admissions on different threads do not poison a replacement connection", async () => {
  const f = await fixture();
  const a = await f.rt.create(f.spec);
  const b = await f.rt.create(f.spec);
  f.admission("disconnect");
  expect((await f.rt.deliver(a, "first uncertain")).kind).toBe("ambiguous");
  expect((await f.rt.deliver(b, "second uncertain")).kind).toBe("ambiguous");
  f.admission("accept");

  await f.rt.resolveDelivery(a);

  expect(await f.rt.deliver(a, "explicit resend")).toEqual({ kind: "delivered", started: true });
});
