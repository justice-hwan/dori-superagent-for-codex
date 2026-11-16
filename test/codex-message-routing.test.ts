import { expect, test } from "bun:test";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { fixture } from "./codex-fixture.test.ts";

test("operator host label is retained separately and cannot replace endpoint authority", async () => {
  const f = await fixture();
  const label = "remote-ssh-discovered:studio";
  const runtime = new CodexRuntime(f.root, { ...f.env, DORI_CODEX_HOST_LABEL: label });
  const ref = await runtime.create({ ...f.spec, role: "lead" });
  const store = new CodexStore(f.root);
  expect((await store.owned(ref)).envelope).toEqual({
    version: 1,
    endpoint: f.env.DORI_CODEX_SOCKET,
    hostLabel: label,
  });
  const before = f.requests.length;
  const wrong = new CodexRuntime(f.root, {
    ...f.env,
    DORI_CODEX_SOCKET: "ws://127.0.0.1:1",
    DORI_CODEX_HOST_LABEL: label,
  });
  await expect(wrong.probe(ref)).rejects.toMatchObject({ kind: "ownership" });
  expect(f.requests.slice(before)).toEqual([]);
  expect((await store.owned(ref)).envelope?.hostLabel).toBe(label);
  expect(
    () => new CodexRuntime(f.root, { ...f.env, DORI_CODEX_SOCKET: undefined, DORI_CODEX_HOST_LABEL: label }),
  ).toThrow("explicit Codex endpoint");
});

test("an absent display label remains absent rather than inferring a local or studio host", async () => {
  const f = await fixture();
  const runtime = new CodexRuntime(f.root, { ...f.env, DORI_CODEX_HOST_LABEL: undefined });
  const ref = await runtime.create(f.spec);
  expect((await new CodexStore(f.root).owned(ref)).envelope).toEqual({ version: 1, endpoint: f.env.DORI_CODEX_SOCKET });
});

test("failed explicit takeback restores the hold and ordinary watching never resumes held threads", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  await f.rt.handoff(ref, true);
  f.failAttach();
  const before = f.requests.length;
  await expect(f.rt.handoff(ref, false)).rejects.toMatchObject({ kind: "remote" });
  expect((await new CodexStore(f.root).owned(ref)).desktopOwned).toBe(true);
  expect(f.requests.slice(before).filter((request) => request["method"] === "thread/resume")).toHaveLength(1);
  const held = f.requests.length;
  expect(await f.rt.deliver(ref, "Must remain queued.")).toMatchObject({ kind: "not-ready", status: "blocked" });
  await expect(f.rt.close(ref)).rejects.toMatchObject({ kind: "ownership" });
  const observed: string[] = [];
  const stop = await f.rt.watchIdle(async (found) => {
    observed.push(found.id);
  });
  try {
    expect(f.requests.slice(held)).toEqual([]);
    expect(observed).toEqual([]);
  } finally {
    stop();
  }
  expect(f.requests.filter((request) => request["method"] === "thread/archive")).toEqual([]);
});
