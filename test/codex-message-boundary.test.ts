import { expect, onTestFinished, test } from "bun:test";
import { deliver } from "../src/runtime/codex/delivery.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexConnection, object, type Notification } from "../src/runtime/codex/protocol.ts";
import { fixture } from "./codex-fixture.test.ts";

test("adopted managed creation does not inject a privileged management MCP child", async () => {
  const f = await fixture();
  const runtime = new CodexRuntime(f.root, { ...f.env, DORI_CODEX_BRIDGE: "stdio", BUN_BIN: process.execPath });
  await runtime.create({ ...f.spec, role: "lead" });
  const servers = object(object(f.params()["config"])["mcp_servers"]);
  expect(servers["dori"]).toBeUndefined();
});

test("fresh product delivery subscribes before relying on canonical completion events", async () => {
  const f = await fixture();
  const ref = await f.rt.create(f.spec);
  const fresh = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  onTestFinished(() => fresh.disconnect());
  const token = crypto.randomUUID(),
    barrier = Promise.withResolvers<void>();
  const completions: Notification[] = [];
  fresh.listeners.add((event) => {
    if (event.method === "turn/completed" && event.params["threadId"] === ref.id) completions.push(event);
    if (event.method === "fixture/barrier" && event.params["token"] === token) barrier.resolve();
  });
  await fresh.call("thread/read", { threadId: ref.id, includeTurns: false });
  await fresh.call("thread/turns/list", { threadId: ref.id, limit: 1, itemsView: "full" });
  expect(await deliver(new CodexStore(f.root), fresh, ref, "one ordinary task")).toMatchObject({ kind: "delivered" });
  const completed = f.finish(ref.id, "Ordinary completed answer");
  f.barrier(token);
  await barrier.promise;
  expect(completions).toHaveLength(1);
  expect(object(completions[0]?.params["turn"])["id"]).toBe(completed.id);
});
