import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nativeFixture } from "./fixtures/codex-proxy.ts";
import { NativeIoError, queueNativeMessage, readNativeThread } from "../src/runtime/codex-io.ts";

const message = {
  text: "Lane evidence: exact image.png\n\uD55C\uAE00 and 'quotes'",
  clientUserMessageId: "message-23",
};
const rig = async (mode: string) => {
  const directory = await mkdtemp("/tmp/dori-native-io-");
  const target = { threadId: "019bbcab-a128-7000-a111-998877665544", cwd: directory };
  const socket = join(directory, "daemon.sock");
  const server = nativeFixture(socket, directory, target.threadId, mode);
  onTestFinished(async () => {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  const options = { socket };
  const requests = async () =>
    (await Bun.file(join(directory, "requests")).text())
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line));
  const closed = async () => {
    expect(existsSync(join(directory, "closed"))).toBe(true);
    expect(await Bun.file(join(directory, "closed")).text()).toBe("1000\n");
  };
  return { directory, target, options, requests, closed };
};

test("reads only the selected thread metadata and joins its WebSocket", async () => {
  const f = await rig("idle");
  const thread = await readNativeThread(f.target, f.options);
  expect(thread).toEqual({ ...f.target, status: "idle" });
  expect(await f.requests()).toMatchObject([
    { method: "initialize" },
    { method: "initialized" },
    { method: "thread/read", params: { threadId: f.target.threadId, includeTurns: false } },
  ]);
  expect(existsSync(join(f.directory, "accepted"))).toBe(false);
  await f.closed();
});

test.each(["idle", "active"])("native queue accepts exact input while the selected thread is %s", async (mode) => {
  const f = await rig(mode);
  const result = await queueNativeMessage(f.target, message, f.options);
  expect(result).toEqual({ kind: "accepted", queueId: "native-queue-17", clientUserMessageId: "message-23" });
  expect(JSON.parse(await Bun.file(join(f.directory, "accepted")).text())).toEqual({
    threadId: f.target.threadId,
    input: [{ type: "text", text: message.text, text_elements: [] }],
    clientUserMessageId: "message-23",
  });
  expect(await Bun.file(join(f.directory, "starts")).text()).toBe("websocket\n");
  await f.closed();
});

test.each([
  "wrong-thread",
  "wrong-workspace",
  "malformed-thread",
  "malformed-workspace",
  "bad-status",
  "not-loaded",
  "disconnect-read",
])("rejects %s before any queue admission without starting or resuming a thread", async (mode) => {
  const f = await rig(mode);
  expect(await queueNativeMessage(f.target, message, f.options)).toMatchObject({ kind: "rejected" });
  expect(existsSync(join(f.directory, "accepted"))).toBe(false);
  expect(await f.requests()).toMatchObject([
    { method: "initialize" },
    { method: "initialized" },
    { method: "thread/read" },
  ]);
});

test("holds a queue error even when the fake did not persist input", async () => {
  const f = await rig("rejected");
  expect(await queueNativeMessage(f.target, message, f.options)).toEqual({
    kind: "unknown",
    disposition: "HELD",
    clientUserMessageId: "message-23",
    detail: "Native request rejected",
  });
  expect(existsSync(join(f.directory, "accepted"))).toBe(false);
  expect(await Bun.file(join(f.directory, "starts")).text()).toBe("websocket\n");
  await f.closed();
});

test.each([
  "disconnect-queue",
  "disconnect-accepted",
  "accepted-error",
  "ack-client",
  "ack-input",
  "ack-id",
  "ack-json",
  "ack-rpc",
])("holds unknown acceptance after %s and never retries it", async (mode) => {
  const f = await rig(mode);
  const outcome = await queueNativeMessage(f.target, message, f.options);
  if (mode === "disconnect-queue") expect(existsSync(join(f.directory, "accepted"))).toBe(false);
  else
    expect(JSON.parse(await Bun.file(join(f.directory, "accepted")).text())).toMatchObject({
      threadId: f.target.threadId,
      clientUserMessageId: "message-23",
    });
  expect(outcome).toMatchObject({
    kind: "unknown",
    disposition: "HELD",
    clientUserMessageId: "message-23",
  });
  if (mode === "accepted-error") expect(outcome).toMatchObject({ detail: "Native queue internal error" });
  expect(await f.requests()).toMatchObject([
    { method: "initialize" },
    { method: "initialized" },
    { method: "thread/read" },
    { method: "thread/queue/add" },
  ]);
  expect(await Bun.file(join(f.directory, "starts")).text()).toBe("websocket\n");
});

test("preserves a valid queue acknowledgement when the WebSocket disconnects immediately afterwards", async () => {
  const f = await rig("disconnect-ack");
  expect(await queueNativeMessage(f.target, message, f.options)).toEqual({
    kind: "accepted",
    queueId: "native-queue-17",
    clientUserMessageId: "message-23",
  });
  await f.closed();
});

test.each(["wrong-thread", "read-rejected"])(
  "a %s read preserves its error after closing its WebSocket",
  async (mode) => {
    const f = await rig(mode);
    const error = await readNativeThread(f.target, f.options).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(NativeIoError);
    expect(error).toMatchObject(mode === "read-rejected" ? { kind: "remote", code: -32602 } : { kind: "identity" });
    await f.closed();
  },
);

test("operation completion closes only its WebSocket without waiting for a native turn", async () => {
  const f = await rig("active");
  expect(await queueNativeMessage(f.target, message, f.options)).toMatchObject({ kind: "accepted" });
  await f.closed();
  // The local server remains usable; client disposal does not stop a shared daemon.
  expect(await readNativeThread(f.target, f.options)).toMatchObject({ status: "active" });
  expect(await Bun.file(join(f.directory, "starts")).text()).toBe("websocket\nwebsocket\n");
});

test.each(["stall-initialize", "stall-queue"])("bounds %s over a real Unix WebSocket without retry", async (mode) => {
  const f = await rig(mode);
  const result = await queueNativeMessage(f.target, message, { ...f.options, timeoutMs: 100 });
  expect(result).toMatchObject(
    mode === "stall-queue" ? { kind: "unknown", disposition: "HELD" } : { kind: "rejected" },
  );
  expect(await Bun.file(join(f.directory, "starts")).text()).toBe("websocket\n");
  expect(existsSync(join(f.directory, "accepted"))).toBe(mode === "stall-queue");
});

test("a missing local Unix socket fails without a retry or new listener", async () => {
  const f = await rig("idle");
  const result = await queueNativeMessage(f.target, message, {
    socket: join(f.directory, "missing.sock"),
    timeoutMs: 100,
  });
  expect(result).toMatchObject({ kind: "rejected" });
  expect(existsSync(join(f.directory, "starts"))).toBe(false);
});
