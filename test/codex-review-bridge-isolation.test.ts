import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Refusal } from "../src/refusal.ts";
import { Store } from "../src/store.ts";
import type { Lane } from "../src/store-types.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

test("review threads disable every MCP server inherited from the user Codex config", async () => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  writeFileSync(
    join(codexHome, "config.toml"),
    '[mcp_servers.fixture_writer]\ncommand = "/usr/bin/true"\n\n[mcp_servers.fixture_reader]\ncommand = "/usr/bin/true"\n',
  );
  const rt = new CodexRuntime(f.root, { ...f.env, CODEX_HOME: codexHome });

  const pending = rt.runReview("Review with inherited user servers");
  f.finish(await f.started, "VERDICT: PASS");
  expect((await pending).code).toBe(0);

  const config = object(f.params()["config"]);
  const servers = object(config["mcp_servers"] ?? {});
  console.info("REVIEW_MCP_SERVERS", servers);
  expect(f.params()).toMatchObject({ sandbox: "read-only" });
  expect(config["shell_environment_policy"]).toBeDefined();
  expect(servers).toEqual({ fixture_writer: { enabled: false }, fixture_reader: { enabled: false } });
});

const bridgeSetup = async () => {
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
    cwd: realpathSync(f.spec.cwd),
    role: "lead",
    key: "",
    id: lead.id,
  };
  return { f, d, scope };
};

test.each(["done", "lost"] as const)("dori_start refuses a %s lane key owned by another workspace", async (status) => {
  const { f, d, scope } = await bridgeSetup();
  const foreign = mkdtempSync(join(homedir(), ".dori-foreign-workspace-"));
  onTestFinished(() => rmSync(foreign, { recursive: true, force: true }));
  const key = `foreign-${status}`;
  const brief = d.store.briefPath(key);
  mkdirSync(dirname(brief), { recursive: true });
  writeFileSync(brief, "foreign brief");
  const record: Lane = {
    key,
    sessionRef: { runtime: "codex", id: "foreign-session" },
    paneId: "foreign-session",
    tabId: "",
    brief,
    cwd: foreign,
    status,
    createdAt: 1,
    lastActivityAt: 1,
    nudges: 0,
    log: [{ at: 1, kind: status, text: "archived in another workspace" }],
  };
  d.store.saveLane(record);
  const calls = f.calls.length;

  let outcome = "started";
  try {
    await callBridgeTool(d, scope, "dori_start", { key, brief: "overwrite from this workspace" });
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    outcome = "refused";
  }
  const after = { brief: readFileSync(brief, "utf8"), lane: d.store.lane(key), calls: f.calls.length };
  console.info("FOREIGN_ARCHIVED_LANE", { status, outcome, cwd: after.lane?.cwd, laneStatus: after.lane?.status });
  expect({ outcome, ...after }).toEqual({ outcome: "refused", brief: "foreign brief", lane: record, calls });
});

test("dori_start still reuses an archived key from its own workspace", async () => {
  const { d, scope } = await bridgeSetup();
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "first" });
  const first = d.store.lane("audit");
  if (!first) throw new TypeError("Missing started lane");
  d.store.saveLane({ ...first, status: "done" });

  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "second" });
  const second = d.store.lane("audit");
  expect(second?.status).toBe("working");
  expect(second?.sessionRef.id).not.toBe(first.sessionRef.id);
  expect(readFileSync(d.store.briefPath("audit"), "utf8").startsWith("second")).toBe(true);
});
