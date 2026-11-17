import { expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeSetup } from "./native-setup.ts";
import { NativeState } from "../src/native-state.ts";

test("a native lane boots through real Unix WS without invoking an omo command", async () => {
  const f = nativeSetup();
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "Implement the bounded task.");
  const result = await f.run("start", "native-lane", "--brief", brief);
  expect(result).toMatchObject({ code: 0 });
  expect(result.stdout).toMatch(/STARTED native-lane pane=codex:/);
  expect(f.threads.size).toBe(1);
  expect(f.queued).toHaveLength(1);
  const text = JSON.stringify(f.queued);
  expect(f.queued[0]).toMatchObject({
    input: [{ type: "text", text: expect.stringContaining("Implement the bounded task.") }],
  });
  expect(text).toContain("DORI_RUNTIME=codex");
  expect(text).toContain("DORI_SELF=");
  expect(text).not.toContain("FORBIDDEN-OMO");
  expect(f.calls.filter((c) => c.method === "thread/start")).toHaveLength(1);
});

test.each(["lost-create", "accepted-error", "bad-client"])(
  "a %s bootstrap stays HELD and cannot create or submit again",
  async (mode) => {
    const f = nativeSetup(mode);
    const brief = join(f.root, "brief.md");
    writeFileSync(brief, "One irreversible bootstrap.");
    const first = await f.run("start", "held-lane", "--brief", brief);
    expect(first.code).toBe(2);
    expect(first.stderr).toContain("HELD");
    const state = new NativeState(f.home).launch("lane:held-lane");
    expect(state?.state).toBe("held");
    expect(state?.threadId === undefined).toBe(mode === "lost-create");
    const count = f.calls.length;
    expect((await f.run("start", "held-lane", "--brief", brief)).code).toBe(2);
    expect(f.calls).toHaveLength(count);
    expect(f.threads.size).toBe(1);
    expect(f.queued).toHaveLength(mode === "lost-create" ? 0 : 1);
  },
);

test("READY/busy checks gate owned archive, and close never unsubscribes", async () => {
  const f = nativeSetup();
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "Finish one lane.");
  expect((await f.run("start", "finish-lane", "--brief", brief)).code).toBe(0);
  const thread = [...f.threads.values()][0];
  if (!thread) throw new Error("No native thread");
  expect((await f.run("done", "finish-lane")).code).toBe(2);
  expect((await f.run("ready", "finish-lane", "--text", "done", "--evidence", "local-result")).code).toBe(0);
  thread.status = "active";
  expect((await f.run("done", "finish-lane")).code).toBe(2);
  expect(f.calls.filter((c) => c.method === "thread/archive")).toHaveLength(0);
  thread.status = "idle";
  expect((await f.run("done", "finish-lane")).code).toBe(0);
  expect(thread.archived).toBe(true);
  expect(f.calls.filter((c) => c.method === "thread/archive")).toHaveLength(1);
  expect(f.calls.some((c) => c.method === "thread/unsubscribe")).toBe(false);
  expect(JSON.parse(readFileSync(join(f.home, "lanes", "finish-lane.json"), "utf8")).status).toBe("done");
});

test("an archive error after native archival is retained, never reported as DONE or replayed", async () => {
  const f = nativeSetup("archive-accepted-error");
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "Finish once.");
  await f.run("start", "archive-lane", "--brief", brief);
  await f.run("ready", "archive-lane", "--text", "done", "--evidence", "local-result");
  expect((await f.run("done", "archive-lane")).code).not.toBe(0);
  const thread = [...f.threads.values()][0];
  if (!thread) throw new Error("No native thread");
  expect(thread.archived).toBe(true);
  expect(new NativeState(f.home).owned(thread.id)?.archiveState).toBe("held");
  expect((await f.run("done", "archive-lane")).stderr).toContain("HELD");
  expect(f.calls.filter((c) => c.method === "thread/archive")).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(f.home, "lanes", "archive-lane.json"), "utf8")).status).toBe("ready");
});

test("native self/role routing uses the explicit owned ref and rejects foreign identity", async () => {
  const f = nativeSetup();
  expect((await f.run("role", "lead", `codex:${crypto.randomUUID()}`)).code).toBe(2);
  expect((await f.run("role", "lead", "hc:t7")).code).toBe(2);
  expect(f.calls).toHaveLength(0);
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "Own this lane.");
  await f.run("start", "self-lane", "--brief", brief);
  const id = [...f.threads.keys()][0];
  if (!id) throw new Error("No native ref");
  for (const role of ["duty-loop", "hourly-loop"]) expect((await f.run("role", role, `codex:${id}`)).code).toBe(2);
  f.env["DORI_SELF"] = `codex:${id}`;
  f.env["HC_TERMINAL_ID"] = "t7";
  expect((await f.run("role", "lead")).code).toBe(0);
  expect(JSON.parse(readFileSync(join(f.home, "roles.json"), "utf8")).lead).toBe(`codex:${id}`);
  expect(new NativeState(f.home).owned(id)?.modelProvider).toBe("reported-provider");
});

test("status is read-only and a fabricated PID record is not host authority", async () => {
  const f = nativeSetup();
  let metrics = 0;
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      metrics++;
      return Response.json({});
    },
  });
  f.env["DORI_TELEMETRY"] = "1";
  f.env["DO_NOT_TRACK"] = "0";
  f.env["DORI_TELEMETRY_ENDPOINT"] = receiver.url.href;
  try {
    writeFileSync(join(f.home, "native-host.json"), JSON.stringify({ pid: process.pid, phase: "running" }));
    const before = readdirSync(f.home).sort();
    const result = await f.run("status");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("RUNTIME codex");
    expect(result.stdout).toContain("HOST stopped");
    expect(readdirSync(f.home).sort()).toEqual(before);
    for (const command of ["duty", "loop"]) {
      expect((await f.run(command, "status")).code).toBe(0);
      expect(readdirSync(f.home).sort()).toEqual(before);
    }
    expect(f.calls).toHaveLength(0);
    expect(metrics).toBe(0);
  } finally {
    await receiver.stop(true);
  }
});

test("a sender killed after native persistence leaves a durable HELD intent that duty cannot replay", async () => {
  const f = nativeSetup();
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "One lane.");
  await f.run("start", "crash-lane", "--brief", brief);
  f.setMode("hold-send");
  const child = f.spawn("send", "crash-lane", "--text", "Persisted in native queue, ACK not observed.");
  const outputs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await f.waitQueued(2);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await outputs;
  }
  const id = [...f.threads.keys()][0];
  if (!id) throw new Error("No native ref");
  const inbox = JSON.parse(readFileSync(join(f.home, "inbox", `codex--${id}.jsonl`), "utf8"));
  f.setMode("normal");
  expect((await f.run("duty", "--once")).code).toBe(0);
  expect(f.queued).toHaveLength(2);
  expect(inbox.attempt?.state).toBe("ambiguous");
});
