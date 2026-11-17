import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { review, mergeGate } from "../src/gate.ts";
import { nativeSetup } from "./native-setup.ts";
import { nativeDeps } from "./native-deps.ts";
import { NativeState } from "../src/native-state.ts";

const head = "a".repeat(40);

test("built-in native review records actual model/provider only after native completion, preserving exact-head merge authority", async () => {
  const f = nativeSetup("never-complete");
  const { d, w } = nativeDeps(f);
  let current = head;
  w.gh = (args) =>
    args[1] === "view"
      ? { code: 0, stdout: JSON.stringify({ headRefOid: current }) }
      : { code: 0, stdout: JSON.stringify([{ name: "test", bucket: "pass" }]) };
  const pending = review(d, "o/r#7");
  await Promise.race([
    f.waitQueued(1),
    pending.then(() => {
      throw new Error("review returned before native completion");
    }),
  ]);
  expect(d.store.receipt("o/r#7", head)).toBeUndefined();
  const id = [...f.threads.keys()][0];
  if (!id) throw new Error("No reviewer thread");
  current = "b".repeat(40);
  f.complete(id);
  expect(await pending).toEqual({ verdict: "CLEAR", sha: head });
  expect(d.store.receipt("o/r#7", head)).toMatchObject({
    model: "gpt-test",
    verdict: "CLEAR",
  });
  const admitted = f.threads.get(id)?.items.find((entry) => entry.item["type"] === "userMessage");
  if (!admitted) throw new Error("No admitted review input");
  expect(new NativeState(f.home).owned(id)).toMatchObject({
    threadId: id,
    model: "gpt-test",
    modelProvider: "reported-provider",
    completionTurnId: admitted.turnId,
  });
  expect(f.threads.get(id)?.archived).toBe(true);
  await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
  expect(w.calls.every((c) => c.cmd === "gh")).toBe(true);
  expect(f.queued).toHaveLength(1);
});

test("strict native mode rejects an explicit reviewCommand before any model or GitHub command", async () => {
  const f = nativeSetup();
  const { d, w } = nativeDeps(f);
  const path = join(f.home, "config.json");
  writeFileSync(
    path,
    JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), hooks: { reviewCommand: ["external-reviewer"] } }),
  );
  await expect(review(d, "o/r#8")).rejects.toThrow("reviewCommand override");
  expect(w.calls).toHaveLength(0);
  expect(f.calls).toHaveLength(0);
});

test("queue acceptance without native completion produces no review receipt and never cancels or archives the active agent", async () => {
  const f = nativeSetup("never-complete");
  const { d, w } = nativeDeps(f, 500);
  w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: head }) });
  await expect(review(d, "o/r#9")).rejects.toThrow("did not complete");
  expect(d.store.receipt("o/r#9", head)).toBeUndefined();
  expect(f.queued).toHaveLength(1);
  expect(f.calls.some((c) => c.method === "thread/archive" || c.method === "turn/interrupt")).toBe(false);
  const owner = new NativeState(f.home).launches()[0];
  expect(owner?.state).toBe("accepted");
});
