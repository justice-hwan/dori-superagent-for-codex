import { expect, onTestFinished, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { flushInbox, send } from "../src/inbox.ts";
import { releaseHeld } from "../src/inbox-held.ts";
import { admittedThreadForJob } from "../src/runtime/codex/bridge-jobs.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { Store } from "../src/store.ts";
import { envelope, job, setup } from "./fixtures/codex-bridge-jobs.ts";

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
  const changed = JSON.stringify({
    ...object(JSON.parse(envelope)),
    prompt: "Different work",
  });
  await expect(send(d, "lead", changed, "dots")).rejects.toThrow("different work");
  const next = await f.rt.create({ ...f.spec, role: "lead", name: "next" });
  d.store.setRole("lead", next);
  await expect(send(d, "lead", envelope, "dots")).rejects.toThrow("different work");
  expect(d.store.queued(next)).toEqual([]);
});

test("typed outcome hook derives actual admitted identity and rejects unadmitted or caller-selected identity", async () => {
  const { f, d, lead } = await setup();
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
    cwd: realpathSync(f.spec.cwd),
    role: "lead",
    key: "",
    id: lead.id,
  };
  const outcome = {
    job_id: job,
    revision: 1,
    state: "completed",
    summary: "Fixture inspected.",
  };
  await expect(callBridgeTool(d, scope, "dori_report_outcome", outcome)).rejects.toThrow("not delivered");
  await send(d, "lead", envelope, "dots");
  await expect(
    callBridgeTool(d, scope, "dori_report_outcome", {
      ...outcome,
      thread_id: "spoof",
    }),
  ).rejects.toThrow("Unknown");
  await callBridgeTool(d, scope, "dori_report_outcome", outcome);
  const recorded = object(JSON.parse(readFileSync(receipt, "utf8")));
  expect(recorded["thread"]).toBe(lead.id);
  expect(recorded["admitted"]).toBe(lead.id);
  expect(recorded["input"]).toEqual(outcome);
});

test.each(
  (["factory", "call", "result", "close"] as const).flatMap((phase) =>
    (["path", "bare", "scoped", "cached"] as const).map((mode) => ({ phase, mode })),
  ),
)("admitted adapter rejects $mode workspace loaders during $phase", async ({ phase, mode }) => {
  const { f, d, lead } = await setup();
  const trusted = mkdtempSync(join(homedir(), ".dori-adapter-call-"));
  onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
  const module = join(trusted, "adapter.ts");
  const configPath = join(trusted, "config.json");
  const marker = join(trusted, "executed");
  let payload = join(f.spec.cwd, "payload.ts");
  const base = join(f.spec.cwd, "consumer.cjs");
  copyFileSync(new URL("./fixtures/bridge-adapter-runtime.ts", import.meta.url), module);
  writeFileSync(payload, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`);
  if (mode !== "path") {
    payload = mode === "scoped" ? "@fixture/dependency" : "fixture-dependency";
    const dependency = join(f.spec.cwd, "node_modules", payload);
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: payload, main: "./index.cjs" }));
    writeFileSync(
      join(dependency, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "escaped"); module.exports = {unsafe:true};`,
    );
    if (mode === "cached") {
      createRequire(base)(payload);
      rmSync(marker);
    }
  }
  writeFileSync(configPath, JSON.stringify({ phase, payload, base }));
  writeFileSync(
    join(f.root, "config.json"),
    JSON.stringify({
      codexBridgeAdapter: { module, configPath, instance: "personal" },
    }),
  );
  await send(d, "lead", envelope, "dots");
  const scope: BridgeScope = {
    root: realpathSync(f.root),
    cwd: realpathSync(f.spec.cwd),
    role: "lead",
    key: "",
    id: lead.id,
  };

  await expect(
    callBridgeTool(d, scope, "dori_report_outcome", {
      job_id: job,
      revision: 1,
      state: "completed",
      summary: "Bounded fixture",
    }),
  ).rejects.toThrow("Runtime adapter dependencies must be bundled");
  expect(existsSync(marker)).toBe(false);
});
