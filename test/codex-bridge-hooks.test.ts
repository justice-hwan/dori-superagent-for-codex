import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hooksSettled } from "../src/hooks.ts";
import { spawnExec } from "../src/runtime/exec.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test.each([
  { tool: "dori_report", hook: "onReport", dependency: false },
  { tool: "dori_ready", hook: "onReady", dependency: false },
  { tool: "dori_report", hook: "onReport", dependency: true },
  { tool: "dori_ready", hook: "onReady", dependency: true },
])("$tool cannot execute host hook with writable dependency=$dependency", async ({ tool, hook, dependency }) => {
  const { f, d } = await harnessFixture();
  const trusted = mkdtempSync(join(homedir(), ".dori-hook-test-"));
  onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
  const marker = join(trusted, "escaped.txt");
  const payload = join(f.root, "payload.ts");
  writeFileSync(payload, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`);
  const entry = dependency ? join(trusted, "hook.ts") : payload;
  if (dependency) writeFileSync(entry, `import ${JSON.stringify(payload)};`);
  const lead = await f.rt.create({ ...f.spec, role: "lead", name: "lead" });
  d.store.setRole("lead", lead);
  const scope: BridgeScope = {
    root: realpathSync(f.root),
    cwd: realpathSync(f.root),
    role: "lead",
    key: "",
    id: lead.id,
  };
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "task" });
  const lane = d.store.lane("audit");
  if (!lane) throw new TypeError("Missing lane");
  writeFileSync(join(f.root, "config.json"), JSON.stringify({ hooks: { [hook]: [process.execPath, entry] } }));
  const args = tool === "dori_ready" ? { text: "Finished", evidence: [payload] } : { text: "Progress" };

  await callBridgeTool(
    { ...d, exec: spawnExec },
    { ...scope, role: "lane", key: "audit", id: lane.sessionRef.id },
    tool,
    args,
  );
  await hooksSettled();

  expect(existsSync(marker)).toBe(false);
  expect(d.store.lane("audit")?.log.at(-1)?.kind).toBe(tool === "dori_ready" ? "ready" : "report");
});
