import { expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { send } from "../src/inbox.ts";
import { installAdapter } from "../src/runtime/codex/bridge-adapter-install.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { envelope, job, setup } from "./fixtures/codex-bridge-jobs.ts";

test("admitted bundled adapters retain async Node and Bun builtin behavior", async () => {
  const { f, d, lead } = await setup();
  const trusted = mkdtempSync(join(homedir(), ".dori-adapter-builtins-"));
  onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
  const module = join(trusted, "adapter.ts");
  const configPath = join(trusted, "config.json");
  writeFileSync(configPath, '{"value":41}');
  writeFileSync(
    module,
    `
import {createRequire} from "node:module";
import {Buffer} from "node:buffer";
export const leadTools = ["dori_job_status","dori_report_outcome"].map(name => ({
  name, description:"Builtin fixture", inputSchema:{type:"object",properties:{}}
}));
export async function createPersonalTools({configPath,binding}) {
  await Promise.resolve();
  const load = createRequire(import.meta.url);
  const {Database} = load("bun:sqlite");
  const config = await Bun.file(configPath).json();
  const db = new Database(":memory:");
  db.exec("CREATE TABLE fixture (value INTEGER)");
  db.run("INSERT INTO fixture VALUES (?)", config.value);
  return {
    async call(name,input) {
      const os = await import("node:os");
      const thread = await binding.admittedThreadForJob(input.job_id);
      return {
        value:db.query("SELECT value + 1 AS result FROM fixture").get().result,
        name:load("path").basename(load("node:path").join(os.tmpdir(),"probe")),
        encoded:Buffer.from("ok").toString("utf8"), thread,
        command:[process.execPath,load("path").resolve(import.meta.dir,"cli.ts")]
      };
    },
    close() {db.close(true);}
  };
}`,
  );
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
  const installed = await installAdapter(module, scope.cwd);

  const result = await callBridgeTool(d, scope, "dori_report_outcome", {
    job_id: job,
    revision: 1,
    state: "completed",
    summary: "Builtin fixture",
  });

  expect(result).toEqual({
    value: 42,
    name: "probe",
    encoded: "ok",
    thread: lead.id,
    command: [process.execPath, join(dirname(installed), "cli.ts")],
  });
});
