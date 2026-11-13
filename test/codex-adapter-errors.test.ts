import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { array, object, text } from "../src/runtime/codex/protocol.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

const cases = (["discovery", "call"] as const).flatMap((phase) =>
  (["message", "string", "nested", "json-message", "plain"] as const).map((kind) => ({ phase, kind })),
);
test.each(cases)(
  "MCP contains $kind adapter failures during $phase without loading workspace code",
  async ({ phase, kind }) => {
    const f = await fixture();
    const trusted = mkdtempSync(join(homedir(), ".dori-adapter-error-"));
    onTestFinished(() => rmSync(trusted, { recursive: true, force: true }));
    const module = join(trusted, "adapter.ts");
    const configPath = join(trusted, "config.json");
    const marker = join(trusted, "executed");
    const payload = join(f.spec.cwd, "payload.ts");
    writeFileSync(
      payload,
      `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "escaped");`,
    );
    let failure = 'const failure = new Error("adapter fixture failed");';
    if (kind === "message")
      failure += `Object.defineProperty(failure, "message", {get() {load(${JSON.stringify(payload)}); return "escaped";}});`;
    if (kind === "string")
      failure = `const failure = {toString() {load(${JSON.stringify(payload)}); return "escaped";}};`;
    if (kind === "nested")
      failure += `Object.defineProperty(failure, "message", {get() {throw {toString() {load(${JSON.stringify(payload)}); return "escaped";}};}});`;
    if (kind === "json-message")
      failure += `Object.defineProperty(failure, "message", {get() {return {toJSON() {load(${JSON.stringify(payload)}); return "escaped";}};}});`;
    writeFileSync(
      module,
      `import {createRequire} from "node:module";
const load = createRequire(import.meta.url);
${failure}
${phase === "discovery" ? "throw failure;" : ""}
export const leadTools = ["dori_job_status", "dori_report_outcome"].map(name => ({
  name, description:"Fixture", inputSchema:{type:"object",properties:{}}
}));
export const createPersonalTools = async () => ({
  async call() {await Promise.resolve(); throw failure;},
  close() {}
});`,
    );
    writeFileSync(configPath, "{}");
    writeFileSync(
      join(f.root, "config.json"),
      JSON.stringify({
        codexBridgeAdapter: { module, configPath, instance: "personal" },
      }),
    );
    const env = {
      ...f.env,
      DORI_HOME: f.root,
      DORI_RUNTIME: "codex",
      BUN_BIN: process.execPath,
      DORI_CODEX_BRIDGE: "stdio",
    };
    const rt = new CodexRuntime(f.root, env);
    const lead = await rt.create({ ...f.spec, role: "lead", name: "lead" });
    const store = new Store(f.root);
    store.setRole("lead", lead);
    const server = object(object(object(f.params()["config"])["mcp_servers"])["dori"]);
    const job = `job_${"b".repeat(64)}`;
    if (phase === "call") {
      const world = new World();
      const d: Deps = {
        store,
        runtimes: new Runtimes("codex", () => rt),
        choice: () => ({ kind: "codex", source: "env" }),
        exec: world.exec,
        now: () => world.clock,
        agentCmd: "unused",
        doriCmd: "unused",
        host: () => world.host,
        usage: world.recorder,
      };
      await send(
        d,
        "lead",
        JSON.stringify({
          kind: "dots_development_request",
          instance: "personal",
          job_id: job,
          origin_id: "dot",
          request_id: "error-fixture",
          prompt: "Inspect fixture.",
        }),
        "dots",
      );
    }
    const environment: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [key, value] of Object.entries(object(server["env"]))) environment[key] = text(value);
    const messages = [
      { id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      phase === "discovery"
        ? { id: 2, method: "tools/list", params: {} }
        : {
            id: 2,
            method: "tools/call",
            params: {
              name: "dori_report_outcome",
              arguments: {
                job_id: job,
                revision: 1,
                state: "completed",
                summary: "Fixture",
              },
            },
          },
      { id: 3, method: "ping", params: {} },
    ]
      .map((message) => JSON.stringify({ jsonrpc: "2.0", ...message }))
      .join("\n");
    const child = Bun.spawn([text(server["command"]), ...array(server["args"]).map(text)], {
      env: environment,
      stdin: new Blob([`${messages}\n`]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, output, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(existsSync(marker)).toBe(false);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    const responses = output
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)));
    const response = object(responses[1]);
    const message =
      phase === "discovery"
        ? text(object(response["error"])["message"])
        : text(object(array(object(response["result"])["content"])[0])["text"]);
    if (phase === "call") expect(object(response["result"])["isError"]).toBe(true);
    if (kind === "plain") expect(message).toBe("adapter fixture failed");
    expect(responses[2]?.["result"]).toEqual({});
  },
);
