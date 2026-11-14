import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { fixture } from "./codex-fixture.test.ts";

const layered = async () => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.user_reader]\ncommand = "/usr/bin/true"\n');
  mkdirSync(join(f.spec.cwd, ".codex"));
  writeFileSync(join(f.spec.cwd, ".codex", "config.toml"), '[mcp_servers.project_writer]\ncommand = "/usr/bin/true"\n');
  return { f, env: { ...f.env, CODEX_HOME: codexHome, DORI_CODEX_WORKSPACE: f.spec.cwd } };
};
const servers = (params: Record<string, unknown>) => object(object(params["config"])["mcp_servers"] ?? {});
const managedHome = () => {
  const home = mkdtempSync(join(homedir(), ".dori-mcp-layers-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  return home;
};
const managedEnv = (env: Record<string, string | undefined>, home: string) => ({
  ...env,
  DORI_HOME: home,
  DORI_RUNTIME: "codex",
  BUN_BIN: process.execPath,
  DORI_CODEX_BRIDGE: "stdio",
});

test.each([true, false])("review threads disable user and project MCP servers; project trusted=%p", async (trusted) => {
  const { f, env } = await layered();
  f.config.projectTrusted = trusted;
  const rt = new CodexRuntime(f.root, env);

  const pending = rt.runReview("Review with layered config");
  f.finish(await f.started, "VERDICT: PASS");
  expect((await pending).code).toBe(0);

  const listed = servers(f.params());
  console.info("REVIEW_LAYER_SERVERS", { trusted, listed, reads: f.config.reads });
  expect(f.config.reads).toEqual([{ cwd: f.spec.cwd, includeLayers: true }]);
  expect(listed).toEqual({ user_reader: { enabled: false }, project_writer: { enabled: false } });
});

test("managed role threads disable user and project MCP servers beside the management server", async () => {
  const { f, env } = await layered();
  const home = managedHome();
  const rt = new CodexRuntime(home, managedEnv(env, home));

  await rt.create({ ...f.spec, role: "lead", name: "lead" });

  const listed = servers(f.params());
  console.info("MANAGED_LAYER_SERVERS", { listed: Object.keys(listed), reads: f.config.reads });
  expect(f.config.reads).toEqual([{ cwd: f.spec.cwd, includeLayers: true }]);
  expect(Object.keys(listed).sort()).toEqual(["dori", "project_writer", "user_reader"]);
  expect({ user: listed["user_reader"], project: listed["project_writer"] }).toEqual({
    user: { enabled: false },
    project: { enabled: false },
  });
});

test.each(["fail", "malformed"] as const)(
  "review and managed threads refuse to start when config/read is %s",
  async (mode) => {
    const { f, env } = await layered();
    f.config.mode = mode;
    const home = managedHome();
    const outcome = (run: Promise<unknown>) =>
      run.then(
        () => "started",
        () => "refused",
      );

    const review = await outcome(
      new CodexRuntime(f.root, { ...env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" }).runReview("Must not start"),
    );
    const managed = await outcome(
      new CodexRuntime(home, managedEnv(env, home)).create({ ...f.spec, role: "lead", name: "lead" }),
    );

    console.info("CONFIG_READ_FAILURE", {
      mode,
      review,
      managed,
      starts: f.calls.filter((call) => call === "thread/start").length,
    });
    expect({ review, managed, starts: f.calls.filter((call) => call === "thread/start").length }).toEqual({
      review: "refused",
      managed: "refused",
      starts: 0,
    });
  },
);
