import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { startLane } from "../src/lanes.ts";
import { Refusal } from "../src/refusal.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import type { Lane } from "../src/store-types.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

const leadSetup = async () => {
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

const settle = async (runs: readonly Promise<unknown>[]) => {
  const results = await Promise.allSettled(runs);
  for (const result of results)
    if (result.status === "rejected" && !(result.reason instanceof Refusal)) throw result.reason;
  return results.map((result) => (result.status === "fulfilled" ? "started" : "refused")).sort();
};

test("a lane lock left by a crash starts despite its recorded pid now naming a live unrelated process", async () => {
  const { d, scope } = await leadSetup();
  const unrelated = Bun.spawn(["/bin/cat"], { stdin: "pipe", stdout: "ignore" });
  onTestFinished(async () => {
    unrelated.kill();
    await unrelated.exited;
  });
  const stale = JSON.stringify({ pid: unrelated.pid, host: hostname(), at: d.now() });
  const lock = join(d.store.root, "lanes", "reused.lock");
  writeFileSync(lock, stale);
  const legacy = `${lock}.legacy`;
  writeFileSync(legacy, stale);
  const brief = join(d.store.root, "reused-brief.md");
  writeFileSync(brief, "brief");

  const legacyHeld = takeInboxLock(legacy, d.now()) === undefined;
  const outcome = await startLane(d, "reused", brief, { cwd: scope.cwd, owner: scope.cwd }).then(
    () => "started",
    (error: unknown) => (error instanceof Refusal ? error.message : Promise.reject(error)),
  );
  console.info("PID_REUSE_LANE_LOCK", { pid: unrelated.pid, legacyHeld, outcome });
  expect({ legacyHeld, outcome }).toEqual({ legacyHeld: true, outcome: "started" });
});

test("two concurrent dori_start calls from one workspace admit exactly one lane for a new key", async () => {
  const { f, d, scope } = await leadSetup();
  const before = f.calls.filter((call) => call === "thread/start").length;

  const outcomes = await settle([
    callBridgeTool(d, scope, "dori_start", { key: "race", brief: "first" }),
    callBridgeTool(d, scope, "dori_start", { key: "race", brief: "second" }),
  ]);

  const starts = f.calls.filter((call) => call === "thread/start").length - before;
  console.info("SAME_WORKSPACE_RACE", { outcomes, starts, lane: d.store.lane("race")?.sessionRef.id });
  expect({ outcomes, starts }).toEqual({ outcomes: ["refused", "started"], starts: 1 });
});

test.each(["done", "lost"] as const)(
  "an owned start refuses a %s key from another workspace under the lane lock",
  async (status) => {
    const { d, scope } = await leadSetup();
    const foreign = mkdtempSync(join(homedir(), ".dori-race-owner-"));
    onTestFinished(() => rmSync(foreign, { recursive: true, force: true }));
    const key = `owned-${status}`;
    const record: Lane = {
      key,
      sessionRef: { runtime: "codex", id: "foreign-session" },
      paneId: "foreign-session",
      tabId: "",
      brief: d.store.briefPath(key),
      cwd: foreign,
      status,
      createdAt: 1,
      lastActivityAt: 1,
      nudges: 0,
      log: [{ at: 1, kind: status, text: "archived in another workspace" }],
    };
    d.store.saveLane(record);
    const brief = join(foreign, "brief.md");
    writeFileSync(brief, "owned brief");

    await expect(startLane(d, key, brief, { cwd: scope.cwd, owner: scope.cwd })).rejects.toThrow("another workspace");
    expect(d.store.lane(key)).toEqual(record);
  },
);

test("dori_start and a loop start from another workspace admit exactly one lane for a new key", async () => {
  const { f, d, scope } = await leadSetup();
  const foreign = mkdtempSync(join(homedir(), ".dori-race-workspace-"));
  onTestFinished(() => rmSync(foreign, { recursive: true, force: true }));
  const brief = join(foreign, "brief.md");
  writeFileSync(brief, "loop brief");
  const before = f.calls.filter((call) => call === "thread/start").length;

  const outcomes = await settle([
    callBridgeTool(d, scope, "dori_start", { key: "race", brief: "bridge brief" }),
    startLane(d, "race", brief, { cwd: foreign }),
  ]);

  const starts = f.calls.filter((call) => call === "thread/start").length - before;
  console.info("CROSS_WORKSPACE_RACE", { outcomes, starts, cwd: d.store.lane("race")?.cwd });
  expect({ outcomes, starts }).toEqual({ outcomes: ["refused", "started"], starts: 1 });
});
