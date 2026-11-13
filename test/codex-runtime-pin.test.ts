import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backlogAdd } from "../src/backlog.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexStore, reference } from "../src/runtime/codex/store.ts";
import { array, object, text } from "../src/runtime/codex/protocol.ts";
import { Store } from "../src/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test("both workers and their first lane retain the complete runtime pinned before native admission", async () => {
  const { f, d } = await harnessFixture();
  const isolated = mkdtempSync(join(homedir(), ".dori-worker-pin-test-"));
  const workspace = join(isolated, "workspace");
  const checkout = join(workspace, "checkout");
  const authority = join(isolated, "authority");
  const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (const path of [
    ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: source }),
    ...new Bun.Glob("prompts/**/*.md").scanSync({ cwd: source }),
    "scripts/dori-codex.sh",
    "package.json",
    "LICENSE",
  ]) {
    mkdirSync(resolve(checkout, path, ".."), { recursive: true });
    copyFileSync(join(source, path), join(checkout, path));
  }
  const cli = join(checkout, "src/cli.ts");
  const capture = `import { writeFileSync as captureWrite } from "node:fs";
if (process.env["DORI_CODEX_WORKER"]) captureWrite(process.env["DORI_HOME"] + "/codex/sessions/" + process.env["DORI_CODEX_WORKER"] + ".execution", JSON.stringify({source:import.meta.url,cwd:process.cwd()}));\n`;
  writeFileSync(cli, `${readFileSync(cli, "utf8").replace("#!/usr/bin/env bun\n", "")}\n`);
  writeFileSync(cli, capture + readFileSync(cli, "utf8"));
  const harness = join(checkout, "src/harness.ts");
  const original = readFileSync(harness, "utf8");
  const fixed = original.replace(
    "host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() })",
    "host: () => ({ load1: 0, cores: 8, memFreePct: 90 })",
  );
  if (fixed === original) throw new Error("Fixture host setup did not apply");
  writeFileSync(harness, fixed);
  const store = new Store(authority);
  const brief = join(workspace, "brief.md");
  writeFileSync(brief, "Read-only wire-fixture task.");
  backlogAdd({ ...d, store }, "late-lane", brief, { cwd: workspace });
  const sessions = join(authority, "codex/sessions");
  mkdirSync(sessions, { recursive: true });
  const executions = Promise.withResolvers<void>();
  const observeExecutions = () => {
    if (readdirSync(sessions).filter((name) => name.endsWith(".execution")).length === 2) executions.resolve();
  };
  const watcher = watch(sessions, observeExecutions);
  const lane = Promise.withResolvers<void>();
  const escaped = join(authority, "task-code-ran");
  let poisoned = false;
  f.onAdmission((id) => {
    const name = f.threads.get(id)?.name ?? "";
    if (!poisoned && name.startsWith("Dori lead:")) {
      poisoned = true;
      const bridge = join(checkout, "src/runtime/codex/bridge-server.ts");
      writeFileSync(
        bridge,
        `import {writeFileSync as taskWrite} from "node:fs"; taskWrite(${JSON.stringify(escaped)},"TASK_POISON");\n` +
          readFileSync(bridge, "utf8"),
      );
    }
    if (name === "Dori lane: late-lane") lane.resolve();
  });
  const env = {
    ...f.env,
    HOME: isolated,
    CODEX_HOME: join(isolated, ".codex"),
    BUN_BIN: process.execPath,
    DORI_HOME: authority,
    DORI_RUNTIME: "codex",
    DORI_CODEX_BRIDGE: "stdio",
    DORI_TELEMETRY: "0",
    DORI_CMD: `'${process.execPath}' '${cli}'`,
  };
  const child = Bun.spawn([process.execPath, cli, "up", "--cwd", workspace], {
    env,
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  });
  f.cleanup.push(async () => {
    watcher.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
    const runtime = new CodexRuntime(authority, env);
    for (const entry of await new CodexStore(authority).entries()) await runtime.close(reference(entry));
    rmSync(isolated, { recursive: true, force: true });
  });
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  await Promise.all([executions.promise, lane.promise]);
  expect(poisoned).toBe(true);
  expect(existsSync(escaped)).toBe(false);
  const executionRecords = readdirSync(sessions)
    .filter((name) => name.endsWith(".execution"))
    .map((name) => object(JSON.parse(readFileSync(join(sessions, name), "utf8"))));
  const server = object(object(object(f.params()["config"])["mcp_servers"])["dori"]);
  const entry = text(array(server["args"])[0]);
  expect({
    promotedTaskCode: readFileSync(entry, "utf8").includes("TASK_POISON"),
    workersFromProtectedSource: executionRecords.every((execution) => !text(execution["source"]).includes(workspace)),
    workersOutsideWorkspace: executionRecords.every((execution) => !text(execution["cwd"]).includes(workspace)),
  }).toEqual({ promotedTaskCode: false, workersFromProtectedSource: true, workersOutsideWorkspace: true });
});
