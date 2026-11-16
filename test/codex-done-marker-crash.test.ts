import { expect, onTestFinished, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { MessageController } from "../src/runtime/codex/messages.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test("crash before submit hint leaves bound action pending without consuming or closing", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  const lane = await f.rt.create({ ...f.spec, role: "lane", env: { DORI_LANE: "audit" } });
  d.store.setRole("lead", lead);
  d.store.saveLane({
    key: "audit",
    sessionRef: lane,
    paneId: lane.id,
    tabId: "",
    brief: "fixture",
    cwd: f.spec.cwd,
    status: "ready",
    createdAt: d.now(),
    lastActivityAt: d.now(),
    nudges: 0,
    log: [],
    final: { text: "Evidence", evidence: ["fixture"], at: d.now() },
  });
  await f.rt.startAgent(lead, { prompt: "Close audit" });
  const turn = f.finish(
    lead.id,
    JSON.stringify({
      version: 1,
      kind: "action",
      tool: "dori_done",
      arguments: { key: "audit" },
    }),
  );
  const store = new CodexStore(f.root);
  const marker = `${store.path(lane.id)}.submit-released`;
  const beforeMarker = readFileSync(marker, "utf8");
  const script = `
import * as fs from "node:fs";
import { spyOn } from "bun:test";
import { CodexStore } from ${JSON.stringify(new URL("../src/runtime/codex/store.ts", import.meta.url).href)};
import { takeManagedSubmit } from ${JSON.stringify(new URL("../src/runtime/codex/submit-lock.ts", import.meta.url).href)};
const release = takeManagedSubmit(new CodexStore(${JSON.stringify(f.root)}), ${JSON.stringify(lane.id)});
if (!release) throw new Error("Missing child submit reservation");
const rename = fs.renameSync;
spyOn(fs, "renameSync").mockImplementation((from, to) => {
  if (to === ${JSON.stringify(marker)}) process.kill(process.pid, "SIGKILL");
  return rename(from, to);
});
console.log("TARGET_SUBMIT_HELD");
await new Response(Bun.stdin).text();
release();
throw new Error("Crash barrier not reached");
`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: process.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  onTestFinished(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  });
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("TARGET_SUBMIT_HELD\n") && output.length < 4096) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`Child ended before barrier: ${output}`);
    output += new TextDecoder().decode(chunk.value);
  }
  reader.releaseLock();
  expect(output).toContain("TARGET_SUBMIT_HELD");
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  expect(
    await new MessageController(d, store, connection).reconcile(lead, {
      method: "turn/completed",
      params: { threadId: lead.id, turn },
    }),
  ).toMatchObject({ kind: "target-busy", resource: "submit", id: lane.id });
  child.stdin.end();
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  expect(readFileSync(marker, "utf8")).toBe(beforeMarker);
  using gate = new Database(`${store.path(lane.id)}.submit-lock.gate.sqlite`);
  expect(() => gate.exec("BEGIN IMMEDIATE; ROLLBACK")).not.toThrow();
  using journal = new Database(`${store.path(lead.id)}.messages.sqlite`, { readonly: true });
  expect(journal.query("SELECT * FROM close_targets").all()).toHaveLength(1);
  expect(journal.query("SELECT * FROM effects").all()).toEqual([]);
  expect(d.store.lane("audit")?.status).toBe("ready");
  expect(f.calls.filter((method) => method === "thread/unsubscribe")).toEqual([]);
  // No notification is invented. A later normal recovery can reconsider the same durable binding.
  await new MessageController(d, store, connection).reconcile(lead);
  expect(d.store.lane("audit")?.status).toBe("done");
  expect(f.calls.filter((method) => method === "thread/unsubscribe")).toHaveLength(1);
});
