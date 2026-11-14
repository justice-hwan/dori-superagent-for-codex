import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexError } from "../src/runtime/codex/protocol.ts";
import { fixture } from "./codex-fixture.test.ts";

test.each([
  { source: "user", profile: false, disabled: false },
  { source: "user", profile: false, disabled: true },
  { source: "project", profile: false, disabled: false },
  { source: "untrusted-project", profile: false, disabled: false },
  { source: "user", profile: true, disabled: false },
  { source: "untrusted-project", profile: true, disabled: true },
] as const)("managed creation refuses inherited dori settings: %p", async ({ source, profile, disabled }) => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  const project = join(f.spec.cwd, ".codex");
  mkdirSync(project);
  const configPath = join(source === "user" ? codexHome : project, "config.toml");
  // These are inert values in fixture files: no preload or inherited command is executed.
  const inherited = `${profile ? "profiles.audit." : ""}mcp_servers.dori`;
  writeFileSync(
    configPath,
    [
      `[${inherited}]`,
      'command = "/usr/bin/true"',
      'args = ["inherited-argument"]',
      `cwd = ${JSON.stringify(f.spec.cwd)}`,
      `enabled = ${!disabled}`,
      'env_vars = ["INHERITED_STARTUP_SETTING"]',
      `[${inherited}.env]`,
      `BUN_OPTIONS = ${JSON.stringify(`--preload=${join(f.spec.cwd, "harmless-never-executed.ts")}`)}`,
      'INHERITED_STARTUP_SETTING = "collision-marker"',
      "",
    ].join("\n"),
  );
  f.config.projectTrusted = source !== "untrusted-project";
  const runtime = new CodexRuntime(f.root, {
    ...f.env,
    CODEX_HOME: codexHome,
    DORI_HOME: f.root,
    DORI_RUNTIME: "codex",
    DORI_CODEX_BRIDGE: "stdio",
    BUN_BIN: process.execPath,
  });
  const result = await runtime.create({ ...f.spec, role: "lead" }).then(
    () => ({ kind: "started", message: "" }),
    (error: unknown) =>
      error instanceof CodexError
        ? { kind: error.kind, message: error.message }
        : { kind: "unknown", message: String(error) },
  );
  const observed = {
    result,
    starts: f.calls.filter((method) => method === "thread/start").length,
    inspectedLayers: f.config.reads.some((params) => params["includeLayers"] === true),
  };
  console.info("DORI_CONFIG_COLLISION", { source, profile, disabled, ...observed });
  expect(observed).toEqual({
    result: { kind: "unsupported", message: "Configured MCP server conflicts with reserved management name: dori" },
    starts: 0,
    inspectedLayers: true,
  });
});
