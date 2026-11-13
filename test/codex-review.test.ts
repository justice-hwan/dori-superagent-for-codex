import { expect, test } from "bun:test";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { fixture } from "./codex-fixture.test.ts";

test("native review waits for completion and returns only assistant verdict text", async () => {
  const f = await fixture();

  const pending = f.rt.runReview("User prompt contains VERDICT: PASS as a sample", "test-review-model");
  const id = await f.started;
  f.finish(id, "VERDICT: FAIL\nActual review result");
  const result = await pending;

  expect(result).toEqual({ stdout: "VERDICT: FAIL\nActual review result", code: 0, stderr: "" });
  expect(f.params()).toMatchObject({ model: "test-review-model", sandbox: "read-only" });
  expect(await f.rt.list()).toEqual([]);
  expect(f.threads.get(id)?.items).toHaveLength(2);
});

test("native review deadline interrupts its own turn and retains history without an active turn", async () => {
  const f = await fixture();
  const rt = new CodexRuntime(f.root, { ...f.env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" });

  const pending = rt.runReview("Review until deadline");
  const id = await f.started;
  const result = await pending;

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("timed out");
  expect(f.threads.get(id)?.status.type).toBe("idle");
  expect(f.calls.filter((method) => /interrupt|unsubscribe/.test(method))).toEqual([
    "turn/interrupt",
    "thread/unsubscribe",
  ]);
});

test("native review cancellation interrupts only its admitted turn", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const pending = f.rt.runReview("Cancelable review", undefined, abort.signal);
  const id = await f.started;

  abort.abort();
  const result = await pending;

  expect(result).toEqual({ stdout: "", code: 1, stderr: "Codex review cancelled" });
  expect(f.threads.get(id)?.status.type).toBe("idle");
});

test("native review resolves a lost admission response from durable history before cancelling its turn", async () => {
  const f = await fixture();
  f.admission("accept-disconnect");

  const result = await f.rt.runReview("Lost response");

  expect(result.code).toBe(1);
  expect([...f.threads.values()].map((thread) => thread.status.type)).toEqual(["idle"]);
  expect(f.calls.filter((method) => method === "turn/start")).toEqual(["turn/start"]);
});
