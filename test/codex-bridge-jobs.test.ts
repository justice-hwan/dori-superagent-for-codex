import { expect, onTestFinished, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { flushInbox, send } from "../src/inbox.ts";
import { releaseHeld } from "../src/inbox-held.ts";
import { admittedThreadForJob } from "../src/runtime/codex/bridge-jobs.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

const job = `job_${"a".repeat(64)}`;
const envelope = JSON.stringify({
  kind: "dots_development_request",
  instance: "personal",
  job_id: job,
  origin_id: "dot",
  request_id: "one",
  prompt: "Inspect a fixture.",
});
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
  writeFileSync(
    join(f.root, "config.json"),
    JSON.stringify({
      codexBridgeAdapter: { module: "/not-loaded", configPath: "/not-read", instance: "personal" },
    }),
  );
  return { f, d, lead };
};

test("a queued job becomes durable lead authority only after confirmed native delivery", async () => {
  const { f, d, lead } = await setup();
  await f.rt.deliver(lead, "busy");
  expect(await send(d, "lead", envelope, "dots")).toBe("QUEUED");
  expect(admittedThreadForJob(d.store.root, job)).toBeUndefined();
  f.finish(lead.id, "idle");
  await flushInbox(d, lead);
  expect(admittedThreadForJob(new Store(d.store.root).root, job)).toBe(lead.id);
});

test.each(["ack", "resend"] as const)("ambiguous job authority waits for explicit %s and confirmation", async (how) => {
  const { f, d, lead } = await setup();
  f.admission("disconnect");
  expect(await send(d, "lead", envelope, "dots")).toBe("HELD");
  expect(admittedThreadForJob(d.store.root, job)).toBeUndefined();
  await releaseHeld(d, "lead", 1, how);
  if (how === "resend") {
    expect(admittedThreadForJob(d.store.root, job)).toBeUndefined();
    f.admission("accept");
    await flushInbox(d, lead);
  }
  expect(admittedThreadForJob(d.store.root, job)).toBe(lead.id);
});

test("existing request correlation cannot move to a replacement lead or different prompt", async () => {
  const { f, d, lead } = await setup();
  await send(d, "lead", envelope, "dots");
  f.finish(lead.id, "done");
  const changed = JSON.stringify({ ...object(JSON.parse(envelope)), prompt: "Different work" });
  await expect(send(d, "lead", changed, "dots")).rejects.toThrow("different work");
  const next = await f.rt.create({ ...f.spec, role: "lead", name: "next" });
  d.store.setRole("lead", next);
  await expect(send(d, "lead", envelope, "dots")).rejects.toThrow("different work");
  expect(d.store.queued(next)).toEqual([]);
});

test("typed outcome hook derives actual admitted identity and rejects unadmitted or caller-selected identity", async () => {
  const { d, lead } = await setup();
  const trusted = mkdtempSync(join(homedir(), ".dori-adapter-test-"));
  onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
  const module = join(trusted, "adapter.ts");
  const configPath = join(trusted, "config.json");
  const receipt = join(trusted, "receipt.jsonl");
  copyFileSync(new URL("./fixtures/bridge-adapter.ts", import.meta.url), module);
  writeFileSync(configPath, JSON.stringify({ receipt }));
  writeFileSync(
    join(d.store.root, "config.json"),
    JSON.stringify({
      codexBridgeAdapter: { module, configPath, instance: "personal" },
    }),
  );
  const scope: BridgeScope = {
    root: realpathSync(d.store.root),
    cwd: realpathSync(d.store.root),
    role: "lead",
    key: "",
    id: lead.id,
  };
  const outcome = { job_id: job, revision: 1, state: "completed", summary: "Fixture inspected." };
  await expect(callBridgeTool(d, scope, "dori_report_outcome", outcome)).rejects.toThrow("not delivered");
  await send(d, "lead", envelope, "dots");
  await expect(callBridgeTool(d, scope, "dori_report_outcome", { ...outcome, thread_id: "spoof" })).rejects.toThrow(
    "Unknown",
  );
  await callBridgeTool(d, scope, "dori_report_outcome", outcome);
  const recorded = object(JSON.parse(readFileSync(receipt, "utf8")));
  expect(recorded["thread"]).toBe(lead.id);
  expect(recorded["admitted"]).toBe(lead.id);
  expect(recorded["input"]).toEqual(outcome);
});
