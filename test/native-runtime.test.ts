import { expect, test } from "bun:test";
import { NativeState } from "../src/native-state.ts";
import { send, flushInbox } from "../src/inbox.ts";
import { nativeSetup } from "./native-setup.ts";
import { nativeDeps } from "./native-deps.ts";

test("accepted ownership reuses/resumes the same thread without another bootstrap input", async () => {
  const f = nativeSetup();
  const { rt } = nativeDeps(f);
  const spec = { key: "lead", name: "lead", cwd: f.cwd };
  const render = async () => "Native role bootstrap.";
  const ref = await rt.launchAgent(spec, render);
  expect(await rt.launchAgent(spec, render)).toEqual(ref);
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("No native thread");
  thread.status = "notLoaded";
  const count = f.calls.length;
  expect(await rt.probe(ref)).toMatchObject({ status: "unknown", title: "lead (notLoaded)" });
  expect(f.calls.slice(count).some((c) => c.method === "thread/resume")).toBe(false);
  expect(await rt.launchAgent(spec, render)).toEqual(ref);
  expect(f.calls.filter((c) => c.method === "thread/resume").map((c) => c.params)).toEqual([
    { threadId: ref.id, excludeTurns: true },
  ]);
  expect(f.threads.size).toBe(1);
  expect(f.queued).toHaveLength(1);
  await expect(rt.launchAgent(spec, async () => "Changed instructions")).rejects.toThrow("instructions changed");
  expect(f.queued).toHaveLength(1);
  expect("start" in rt).toBe(false);
  expect("keys" in rt).toBe(false);
});

test("native active delivery is accepted by native queue and blocked flags remain observable", async () => {
  const f = nativeSetup();
  const { d, rt } = nativeDeps(f);
  const ref = await rt.launchAgent({ key: "lead", name: "lead", cwd: f.cwd }, async () => "Bootstrap.");
  d.store.setRole("lead", ref);
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("No native thread");
  thread.status = "active";
  thread.flags = ["waitingOnApproval"];
  expect(await rt.probe(ref)).toMatchObject({ status: "blocked", shellInFront: false });
  f.setMode("never-complete");
  expect(await send(d, "lead", "Wait for native idle dispatch.", "test")).toBe("DELIVERED");
  expect(f.queued).toHaveLength(2);
  expect(d.store.queued(ref)).toHaveLength(0);
  expect(thread.status).toBe("active");
  expect(f.calls.some((c) => c.method === "turn/steer" || c.method === "turn/start")).toBe(false);
});

test("ordinary persisted acceptance followed by internal error stays in the existing HELD inbox", async () => {
  const f = nativeSetup();
  const { d, rt } = nativeDeps(f);
  const ref = await rt.launchAgent({ key: "lead", name: "lead", cwd: f.cwd }, async () => "Bootstrap.");
  d.store.setRole("lead", ref);
  f.setMode("accepted-error");
  expect(await send(d, "lead", "Persisted before RPC error.", "dori-delivery")).toBe("HELD");
  expect(f.queued).toHaveLength(2);
  expect(d.store.inboxPanes()).toEqual([ref]);
  expect(d.store.queued(ref)[0]?.attempt?.state).toBe("ambiguous");
  expect(await flushInbox(d, ref)).toBe("held");
  expect(f.queued).toHaveLength(2);
  expect(new NativeState(f.home).owned(ref.id)?.state).toBe("accepted");
});

test("owned reads use bounded supported item pages and never hydrate the full transcript", async () => {
  const f = nativeSetup();
  const { rt } = nativeDeps(f);
  const ref = await rt.launchAgent({ key: "lane", name: "lane", cwd: f.cwd }, async () => "Bootstrap.");
  const thread = f.threads.get(ref.id);
  if (!thread) throw new Error("No native thread");
  for (let i = 0; i < 230; i++)
    thread.items.push({ turnId: `old-${i}`, item: { type: "agentMessage", id: String(i), text: `line-${i}` } });
  const count = f.calls.length;
  const text = await rt.read(ref, 500);
  expect(text).toContain("[native history truncated]");
  const reads = f.calls.slice(count);
  expect(reads.filter((c) => c.method === "thread/items/list")).toHaveLength(4);
  expect(reads.every((c) => c.method !== "thread/read" || c.params["includeTurns"] === false)).toBe(true);
  expect(reads.filter((c) => c.method === "thread/items/list").every((c) => c.params["limit"] === 50)).toBe(true);
  const before = f.calls.length;
  await expect(rt.read({ runtime: "codex", id: crypto.randomUUID() }, 20)).rejects.toThrow("not confirmed owned");
  expect(f.calls).toHaveLength(before);
});
