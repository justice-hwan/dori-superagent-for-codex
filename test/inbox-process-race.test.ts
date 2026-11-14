import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import type { SessionRef } from "../src/runtime/types.ts";

test.each(["ack", "resend"])("%s preserves a separate-process append after the final queue read", async (how) => {
  const root = mkdtempSync(join(tmpdir(), "dori-inbox-process-"));
  const store = new Store(root);
  const ref: SessionRef = { runtime: "herdr", id: "w1:p1" };
  store.enqueue(ref, {
    at: 1,
    from: "lead",
    text: "held",
    deliveryId: crypto.randomUUID(),
    attempt: { at: 1, state: "ambiguous" },
  });
  const spawn = (action: string) =>
    Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/inbox-process-race.ts", import.meta.url)), action], {
      env: { ...process.env, DORI_HOME: root, DORI_RUNTIME: "herdr", DORI_TELEMETRY: "0" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  const writer = spawn(how);
  const children = [writer];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  onTestFinished(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    for (const reader of readers) await reader.cancel();
    rmSync(root, { recursive: true, force: true });
  });
  const checkpoint = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    readers.push(reader);
    const part = await reader.read();
    if (part.done) throw new Error("Queue child exited before its checkpoint");
    return new TextDecoder().decode(part.value);
  };
  const phase = await checkpoint(writer.stdout);
  const appender = spawn("append");
  children.push(appender);
  expect(await checkpoint(appender.stdout)).toContain("STARTED");
  if (phase.includes("snapshot")) await appender.exited;
  else await Promise.race([appender.exited, Bun.sleep(50)]);
  writer.stdin.write("continue");
  writer.stdin.end();
  expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
  expect(await Promise.all(children.map((child) => new Response(child.stderr).text()))).toEqual(["", ""]);
  expect(store.queued(ref).map((message) => message.text)).toEqual(how === "ack" ? ["READY"] : ["held", "READY"]);
});
