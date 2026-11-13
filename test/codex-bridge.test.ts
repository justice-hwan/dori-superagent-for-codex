import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { prepareBridge } from "../src/runtime/codex/bridge-install.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { array, object, text } from "../src/runtime/codex/protocol.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

const setup = async () => {
  const f = await fixture();
  const world = new World();
  const d: Deps = {
    store: new Store(f.root),
    runtimes: new Runtimes("codex", () => f.rt),
    choice: () => ({ kind: "codex", source: "env" }),
    exec: world.exec,
    now: () => world.clock,
    agentCmd: "unused",
    doriCmd: "unused",
    host: () => world.host,
    usage: world.recorder,
  };
  const lead = await f.rt.create({ ...f.spec, role: "lead", name: "lead" });
  d.store.setRole("lead", lead);
  const scope: BridgeScope = {
    root: realpathSync(f.root),
    cwd: realpathSync(f.root),
    role: "lead",
    key: "",
    id: lead.id,
  };
  return { f, d, lead, scope };
};

test("management tools create a lane and preserve report, READY and busy-close semantics", async () => {
  const { f, d, lead, scope } = await setup();
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "Inspect fixture; report evidence." });
  const lane = d.store.lane("audit");
  if (!lane) throw new TypeError("Missing started lane");
  const laneScope: BridgeScope = { ...scope, role: "lane", key: "audit", id: lane.sessionRef.id };

  await callBridgeTool(d, laneScope, "dori_report", { text: "Found 3 rows." });
  await callBridgeTool(d, laneScope, "dori_ready", { text: "Sum is 89.", evidence: ["file:///workspace/result.json"] });
  await expect(callBridgeTool(d, scope, "dori_done", { key: "audit" })).rejects.toThrow("working");
  f.finish(lane.sessionRef.id, "Finished");
  await callBridgeTool(d, scope, "dori_done", { key: "audit" });

  expect(d.store.lane("audit")?.status).toBe("done");
  expect(d.store.queued(lead).map((entry) => entry.text)).toEqual([
    "[REPORT audit] Found 3 rows.",
    "[READY audit] Sum is 89.\nevidence: file:///workspace/result.json",
  ]);
});

test.each([
  { name: "unknown operation", tool: "daemon_rpc", args: {}, error: "not allowed" },
  {
    name: "caller-selected home",
    tool: "dori_start",
    args: { key: "x", brief: "task", home: "/elsewhere" },
    error: "Unknown",
  },
  { name: "caller-selected cwd", tool: "dori_start", args: { key: "x", brief: "task", cwd: "/" }, error: "Unknown" },
  { name: "path key escape", tool: "dori_start", args: { key: "../escape", brief: "task" }, error: "Invalid lane key" },
  { name: "oversized brief", tool: "dori_start", args: { key: "audit", brief: "x".repeat(32769) }, error: "too large" },
  {
    name: "arbitrary session ref",
    tool: "dori_send",
    args: { key: "codex:other", text: "task" },
    error: "Invalid lane key",
  },
  { name: "lead impersonates report", tool: "dori_report", args: { text: "spoof" }, error: "not allowed" },
])("management boundary rejects $name without creating work", async ({ tool, args, error }) => {
  const { f, d, scope } = await setup();
  const before = [...f.calls];
  await expect(callBridgeTool(d, scope, tool, args)).rejects.toThrow(error);
  expect(d.store.lanes()).toEqual([]);
  expect(f.calls).toEqual(before);
});

test("a lane cannot impersonate another lane or invoke lead tools", async () => {
  const { d, scope } = await setup();
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "task" });
  const lane = d.store.lane("audit");
  if (!lane) throw new TypeError("Missing lane");
  const scoped: BridgeScope = { ...scope, role: "lane", key: "audit", id: lane.sessionRef.id };
  await expect(callBridgeTool(d, scoped, "dori_start", { key: "nested", brief: "task" })).rejects.toThrow(
    "not allowed",
  );
  await expect(callBridgeTool(d, scoped, "dori_report", { key: "another", text: "spoof" })).rejects.toThrow("Unknown");
  await expect(callBridgeTool(d, { ...scoped, role: "lead" }, "dori_status", {})).rejects.toThrow("scope mismatch");
  expect(d.store.lanes().map((value) => value.key)).toEqual(["audit"]);
});

test("closed or unregistered capabilities and cross-instance authority are refused", async () => {
  const { f, d, scope, lead } = await setup();
  await expect(callBridgeTool(d, { ...scope, root: realpathSync(homedir()) }, "dori_status", {})).rejects.toThrow(
    "instance mismatch",
  );
  const other = await f.rt.create({ ...f.spec, role: "lead" });
  d.store.setRole("lead", other);
  await expect(callBridgeTool(d, scope, "dori_status", {})).rejects.toThrow("no longer registered");
  await f.rt.close(lead);
  await expect(callBridgeTool(d, scope, "dori_status", {})).rejects.toThrow("closed");
});

test("desktop-owned lead admission remains queued when a lane reports through management tools", async () => {
  const { f, d, lead, scope } = await setup();
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "task" });
  f.finish(lead.id, "ack");
  await f.rt.handoff(lead, true);
  const lane = d.store.lane("audit");
  if (!lane) throw new TypeError("Missing lane");
  await callBridgeTool(d, { ...scope, role: "lane", key: "audit", id: lane.sessionRef.id }, "dori_report", {
    text: "held for desktop",
  });
  expect(d.store.queued(lead).map((entry) => entry.text)).toEqual(["[REPORT audit] held for desktop"]);
  expect(f.threads.get(lead.id)?.items.at(-1)).toEqual({ type: "agentMessage", text: "ack" });
});

test("bridge installation rejects an agent-writable authority home", async () => {
  const f = await fixture();
  expect(() => prepareBridge(f.root, { ...f.spec, role: "lead" }, f.env)).toThrow("outside agent-writable");
});

test("installed stdio server uses an immutable capability to enforce role checks at the real transport", async () => {
  const f = await fixture();
  const home = mkdtempSync(join(homedir(), ".dori-bridge-test-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const env = {
    ...f.env,
    DORI_HOME: home,
    DORI_RUNTIME: "codex",
    BUN_BIN: process.execPath,
    DORI_CODEX_BRIDGE: "stdio",
  };
  const rt = new CodexRuntime(home, env);
  const ref = await rt.create({ ...f.spec, role: "lead", name: "lead" });
  const store = new Store(home);
  store.setRole("lead", ref);
  const server = object(object(object(f.params()["config"])["mcp_servers"])["dori"]);
  const args = array(server["args"]).map(text);
  const serverEnv = object(server["env"]);
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(serverEnv)) environment[key] = text(value);
  const messages = [
    { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { id: 2, method: "tools/call", params: { name: "dori_report", arguments: { text: "spoofed" } } },
    { id: 3, method: "tools/call", params: { name: "dori_status", arguments: {} } },
  ]
    .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
    .join("\n");
  const child = Bun.spawn([text(server["command"]), ...args], {
    env: environment,
    stdin: new Blob([`${messages}\n`]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const responses = output
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
  expect(responses[1]?.["result"]).toMatchObject({
    isError: true,
    content: [{ type: "text", text: "Tool is not allowed for this role" }],
  });
  expect(responses[2]?.["result"]).toEqual({ content: [{ type: "text", text: "[]" }] });
  expect(store.lanes()).toEqual([]);
  await rt.close(ref);
  for (const path of args.slice(1)) rmSync(path);
});
