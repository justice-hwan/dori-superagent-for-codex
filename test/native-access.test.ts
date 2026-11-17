import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { NativeState } from "../src/native-state.ts";
import { nativeDeps } from "./native-deps.ts";
import { nativeSetup } from "./native-setup.ts";

function configure(f: ReturnType<typeof nativeSetup>, fullAccess: unknown) {
  writeFileSync(
    join(f.home, "config.json"),
    JSON.stringify({
      runtime: "codex",
      codex: {
        socket: f.socket,
        model: "gpt-test",
        timeoutMs: 1000,
        turnTimeoutMs: 2000,
        ...(fullAccess === undefined ? {} : { fullAccess }),
      },
    }),
  );
  const brief = join(f.root, "brief.md");
  writeFileSync(brief, "One explicit native access contract.");
  return brief;
}

test.each([undefined, false])("fullAccess=%s retains inherited creation and native input behavior", async (mode) => {
  const f = nativeSetup();
  const brief = configure(f, mode);
  expect((await f.run("start", "inherited", "--brief", brief)).code).toBe(0);
  const creation = f.calls.find((call) => call.method === "thread/start");
  expect(creation?.params["sandbox"]).toBeUndefined();
  expect(creation?.params["approvalPolicy"]).toBeUndefined();
  expect(creation?.params["permissions"]).toBeUndefined();
  expect(f.queued).toHaveLength(1);
});

test.each([null, "true", 1, {}])("invalid fullAccess=%j refuses through the CLI before native I/O", async (value) => {
  const f = nativeSetup();
  const brief = configure(f, value);
  const result = await f.run("start", "invalid", "--brief", brief);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("fullAccess");
  expect(f.calls).toHaveLength(0);
});

test("an explicit per-home opt-in admits full access before real CLI bootstrap input and retains private policy", async () => {
  const f = nativeSetup("require-full-access");
  const brief = configure(f, true);
  expect((await f.run("start", "full", "--brief", brief)).code).toBe(0);
  expect(f.queued).toHaveLength(1);
  const owner = new NativeState(f.home).launch("lane:full");
  expect(owner).toMatchObject({
    fullAccess: true,
    state: "accepted",
    modelProvider: "reported-provider",
    policy: { sandbox: { type: "dangerFullAccess" }, approvalPolicy: "never", activePermissionProfile: null },
  });
  const creation = f.calls.find((call) => call.method === "thread/start");
  expect(creation?.params["permissions"]).toBeUndefined();
});

const refusals = ["policy-sandbox", "policy-approval", "policy-missing", "policy-approval-missing", "policy-extra"];

test.each(refusals)("contradictory creation %s holds the created owner before any bootstrap input", async (mode) => {
  const f = nativeSetup(mode);
  const brief = configure(f, true);
  const result = await f.run("start", "held", "--brief", brief);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("HELD");
  expect(f.queued).toHaveLength(0);
  const owner = new NativeState(f.home).launch("lane:held");
  expect(owner?.state).toBe("held");
  expect(owner?.threadId).toBe([...f.threads.keys()][0]);
  expect(owner?.policy).toBeDefined();
  const count = f.calls.length;
  f.setMode("normal");
  expect((await f.run("start", "held", "--brief", brief)).code).toBe(2);
  expect(f.calls).toHaveLength(count);
  expect(f.threads.size).toBe(1);
});

test.each([false, true])("an accepted actor cannot switch requested access mode from %s", async (initial) => {
  const f = nativeSetup();
  configure(f, initial);
  const { rt } = nativeDeps(f);
  const spec = { key: "lead", name: "lead", cwd: f.cwd };
  const render = async () => "Stable bootstrap.";
  const ref = await rt.launchAgent(spec, render);
  configure(f, !initial);
  const changed = nativeDeps(f).rt;
  const count = f.calls.length;
  await expect(changed.launchAgent(spec, render)).rejects.toThrow("access mode changed");
  expect(await changed.deliver(ref, "No input under a changed mode.")).toEqual({
    kind: "not-ready",
    status: "unknown",
  });
  expect(f.calls).toHaveLength(count);
  expect(f.queued).toHaveLength(1);
});

test("same-mode owned reuse and resume preserve verified full access without another creation or bootstrap", async () => {
  const f = nativeSetup();
  configure(f, true);
  const spec = { key: "lead", name: "lead", cwd: f.cwd };
  const render = async () => "Stable full-access bootstrap.";
  const ref = await nativeDeps(f).rt.launchAgent(spec, render);
  const restored = nativeDeps(f).rt;
  expect(await restored.launchAgent(spec, render)).toEqual(ref);
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("No owned fixture thread");
  thread.status = "notLoaded";
  f.setMode("require-full-access");
  expect(await restored.deliver(ref, "Input after owned full-access resume.")).toMatchObject({ kind: "delivered" });
  expect(f.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "thread/resume").map((call) => call.params)).toEqual([
    { threadId: ref.id, excludeTurns: true, sandbox: "danger-full-access", approvalPolicy: "never" },
  ]);
  expect(f.queued).toHaveLength(2);
  expect(new NativeState(f.home).owned(ref.id)?.resumePolicy).toMatchObject({
    sandbox: { type: "dangerFullAccess" },
    approvalPolicy: "never",
  });
});

test.each(refusals)("contradictory owned resume %s stays held without input or automatic replay", async (mode) => {
  const f = nativeSetup();
  configure(f, true);
  const ref = await nativeDeps(f).rt.launchAgent(
    { key: "lead", name: "lead", cwd: f.cwd },
    async () => "Full-access bootstrap.",
  );
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("No owned fixture thread");
  thread.status = "notLoaded";
  f.setMode(mode);
  expect(await nativeDeps(f).rt.deliver(ref, "Must not reach native input.")).toEqual({
    kind: "not-ready",
    status: "unknown",
  });
  expect(f.queued).toHaveLength(1);
  expect(new NativeState(f.home).owned(ref.id)?.policyHeld).toBe(true);
  const count = f.calls.length;
  f.setMode("normal");
  expect(await nativeDeps(f).rt.deliver(ref, "No retry of a held policy.")).toEqual({
    kind: "not-ready",
    status: "unknown",
  });
  expect(f.calls).toHaveLength(count);
});
