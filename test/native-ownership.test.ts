import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeState } from "../src/native-state.ts";
import { Refusal } from "../src/refusal.ts";
import { nativeDeps } from "./native-deps.ts";
import { nativeSetup } from "./native-setup.ts";

test.each(["pending", "held", "archived"] as const)(
  "a torn %s archive outcome blocks input, resume and archive replay",
  async (outcome) => {
    const f = nativeSetup();
    const { rt } = nativeDeps(f);
    const ref = await rt.launchAgent({ key: "actor", name: "actor", cwd: f.cwd }, async () => "Bootstrap.");
    const state = new NativeState(f.home);
    const owner = state.launch("actor");
    if (!owner) throw new Error("No initial owner");
    // Crash after canonical rename but before the thread snapshot update.
    const name = `launch-${createHash("sha256").update(owner.key).digest("hex")}.json`;
    writeFileSync(
      join(f.home, "native", name),
      JSON.stringify({
        ...owner,
        ...(outcome === "archived" ? { archived: true } : { archiveState: outcome }),
      }),
    );
    const count = f.calls.length;
    await rt.deliver(ref, "Must not be admitted.").then(
      () => undefined,
      () => undefined,
    );
    await rt.close(ref).then(
      () => undefined,
      () => undefined,
    );
    expect(
      f.calls.slice(count).filter((c) => ["thread/queue/add", "thread/resume", "thread/archive"].includes(c.method)),
    ).toEqual([]);
    expect(f.queued).toHaveLength(1);
  },
);

test("an in-flight delivery owns the actor until its outcome and close cannot cross it", async () => {
  const f = nativeSetup();
  const { rt } = nativeDeps(f);
  const ref = await rt.launchAgent({ key: "actor", name: "actor", cwd: f.cwd }, async () => "Bootstrap.");
  f.setMode("hold-read");
  const delivery = rt.deliver(ref, "Delivery before close.");
  let closed: unknown;
  try {
    await f.waitRead();
    closed = await rt.close(ref).then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    f.releaseQueued();
    await delivery;
  }
  expect(closed).toBeInstanceOf(Refusal);
  expect(f.threads.get(ref.id)?.archived).toBe(false);
  expect(await delivery).toMatchObject({ kind: "delivered" });
  expect(f.queued).toHaveLength(2);
  expect(f.calls.filter((c) => c.method === "thread/resume")).toHaveLength(0);
});

test("a thread-snapshot write failure after archive ACK cannot downgrade the canonical closed outcome", async () => {
  const f = nativeSetup();
  const { rt } = nativeDeps(f);
  const ref = await rt.launchAgent({ key: "actor", name: "actor", cwd: f.cwd }, async () => "Bootstrap.");
  f.setMode("hold-archive");
  const closing = rt.close(ref).then(
    () => undefined,
    (error: unknown) => error,
  );
  await f.waitArchive();
  const snapshot = join(f.home, "native", `thread-${ref.id}.json`);
  rmSync(snapshot);
  mkdirSync(snapshot);
  f.releaseQueued();
  await closing;
  expect(f.threads.get(ref.id)?.archived).toBe(true);
  expect(new NativeState(f.home).launch("actor")?.archived).toBe(true);
  expect(f.calls.filter((c) => c.method === "thread/archive")).toHaveLength(1);
});
