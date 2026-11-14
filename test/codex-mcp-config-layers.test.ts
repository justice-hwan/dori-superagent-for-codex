import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
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
  expect(f.config.reads).toEqual([
    { cwd: f.spec.cwd, includeLayers: true },
    { cwd: f.spec.cwd, includeLayers: true },
  ]);
  expect(listed).toEqual({ user_reader: { enabled: false }, project_writer: { enabled: false } });
});

test("managed role threads disable user and project MCP servers beside the management server", async () => {
  const { f, env } = await layered();
  const home = managedHome();
  const rt = new CodexRuntime(home, managedEnv(env, home));

  await rt.create({ ...f.spec, role: "lead", name: "lead" });

  const listed = servers(f.params());
  console.info("MANAGED_LAYER_SERVERS", { listed: Object.keys(listed), reads: f.config.reads });
  expect(f.config.reads).toEqual([
    { cwd: f.spec.cwd, includeLayers: true },
    { cwd: f.spec.cwd, includeLayers: true },
  ]);
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

const admission = (run: Promise<unknown>) =>
  run.then(
    () => "started",
    () => "refused",
  );

test("a server added between config/read and thread/start refuses review and managed threads before any turn", async () => {
  const { f, env } = await layered();
  f.config.lateServer = "late_writer";
  const home = managedHome();

  const review = await admission(
    new CodexRuntime(f.root, { ...env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" }).runReview("Late"),
  );
  f.config.reads.length = 0;
  const managed = await admission(
    new CodexRuntime(home, managedEnv(env, home)).create({ ...f.spec, role: "lead", name: "lead" }),
  );

  const turns = f.calls.filter((call) => call === "turn/start").length;
  console.info("LATE_LAYER_SERVER", { review, managed, turns, statusReads: f.config.statusReads.length });
  expect({ review, managed, turns }).toEqual({ review: "refused", managed: "refused", turns: 0 });
  expect(f.config.closes).toEqual(["thread/archive", "thread/archive"]);
  const stored = async (root: string) => {
    const store = new CodexStore(root);
    await store.entries();
    const directory = dirname(store.path(crypto.randomUUID()));
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => object(JSON.parse(readFileSync(join(directory, name), "utf8"))))
      .map((entry) => ({ closed: entry["closed"], uncertain: entry["uncertain"] }));
  };
  expect([...(await stored(f.root)), ...(await stored(home))]).toEqual([
    { closed: true, uncertain: undefined },
    { closed: true, uncertain: undefined },
  ]);
});

test.each(["fail", "malformed", "hang"] as const)(
  "review and managed threads refuse before any turn when the MCP status read is %s",
  async (mode) => {
    const { f, env } = await layered();
    f.config.statusMode = mode;
    const home = managedHome();
    const bounded = { ...env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" };

    const review = await admission(new CodexRuntime(f.root, bounded).runReview("Status"));
    const managed = await admission(
      new CodexRuntime(home, managedEnv(bounded, home)).create({ ...f.spec, role: "lead", name: "lead" }),
    );

    const turns = f.calls.filter((call) => call === "turn/start").length;
    console.info("STATUS_READ_FAILURE", { mode, review, managed, turns });
    expect({ review, managed, turns }).toEqual({ review: "refused", managed: "refused", turns: 0 });
  },
);

test("a refusal whose close fails keeps the refusal and a recoverable record on review and managed paths", async () => {
  const { f, env } = await layered();
  f.config.lateServer = "late_writer";
  f.config.closeMode = "fail";
  const home = managedHome();
  const failure = (run: Promise<unknown>) =>
    run.then(
      () => "started",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

  const review = await failure(
    new CodexRuntime(f.root, { ...env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" }).runReview("Late"),
  );
  f.config.reads.length = 0;
  const managed = await failure(
    new CodexRuntime(home, managedEnv(env, home)).create({ ...f.spec, role: "lead", name: "lead" }),
  );

  const records = [...(await new CodexStore(f.root).entries()), ...(await new CodexStore(home).entries())].map(
    (entry) => ({ role: entry.spec.role, closed: entry.closed, recoverable: typeof entry.uncertain === "string" }),
  );
  console.info("REFUSAL_CLEANUP_FAILURE", { review, managed, records });
  expect(review).toContain("unexpected MCP servers");
  expect(managed).toContain("unexpected MCP servers");
  expect(records).toEqual([
    { role: "lane", closed: false, recoverable: true },
    { role: "lead", closed: false, recoverable: true },
  ]);
});

test("review and managed threads are recorded before the admission check runs", async () => {
  const { f, env } = await layered();
  f.config.lateServer = "late_writer";
  const home = managedHome();
  const recorded: number[] = [];
  let root = f.root;
  f.config.statusObserver = () => {
    const directory = dirname(new CodexStore(root).path(crypto.randomUUID()));
    recorded.push(readdirSync(directory).filter((name) => name.endsWith(".json")).length);
  };

  await admission(new CodexRuntime(f.root, { ...env, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" }).runReview("Late"));
  root = home;
  f.config.reads.length = 0;
  await admission(new CodexRuntime(home, managedEnv(env, home)).create({ ...f.spec, role: "lead", name: "lead" }));

  console.info("RECORDED_BEFORE_ADMISSION", { recorded });
  expect(recorded).toEqual([1, 1]);
});
