import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { fixture } from "./codex-fixture.test.ts";

const setup = async () => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.user_reader]\ncommand = "/usr/bin/true"\n');
  const home = mkdtempSync(join(homedir(), ".dori-pending-readers-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...f.env, CODEX_HOME: codexHome, DORI_CODEX_WORKSPACE: f.spec.cwd, DORI_CODEX_REVIEW_TIMEOUT_MS: "20" };
  const managed = {
    ...env,
    DORI_HOME: home,
    DORI_RUNTIME: "codex",
    BUN_BIN: process.execPath,
    DORI_CODEX_BRIDGE: "stdio",
  };
  return { f, env, home, managed };
};
const records = (root: string) => {
  const directory = dirname(new CodexStore(root).path(crypto.randomUUID()));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(directory, name));
};
const read = (path: string) => object(JSON.parse(readFileSync(path, "utf8")));
const count = (calls: readonly string[], method: string) => calls.filter((call) => call === method).length;

/** Leaves the record exactly as it stood on disk while the admission check ran, as a crash at that moment would. */
const crashDuringAdmission = async (
  f: Awaited<ReturnType<typeof fixture>>,
  root: string,
  run: () => Promise<unknown>,
) => {
  f.config.lateServer = "late_writer";
  let crashed: { readonly path: string; readonly content: string } | undefined;
  f.config.statusObserver = () => {
    const [path] = records(root);
    if (path) crashed = { path, content: readFileSync(path, "utf8") };
  };
  await run().catch(() => undefined);
  f.config.statusObserver = undefined;
  f.config.lateServer = undefined;
  if (!crashed) throw new TypeError("No record existed during admission");
  writeFileSync(crashed.path, crashed.content);
  return { path: crashed.path, id: String(read(crashed.path)["id"]) };
};

test("the idle watcher never resumes a pending record", async () => {
  const { f, home, managed } = await setup();
  await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const before = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const resumes = count(f.calls, "thread/resume") - before;
  console.info("WATCHER_PENDING_RESUME", { resumes });
  expect(resumes).toBe(0);
});

test("probe reports a pending thread without resuming it", async () => {
  const { f, home, managed } = await setup();
  const { id } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const thread = f.threads.get(id);
  if (!thread) throw new TypeError("Missing fixture thread");
  thread.status = { type: "notLoaded" };
  const before = count(f.calls, "thread/resume");

  const probe = await new CodexRuntime(home, managed).probe({ runtime: "codex", id });

  const resumes = count(f.calls, "thread/resume") - before;
  console.info("PROBE_PENDING_RESUME", { status: probe.status, resumes });
  expect({ status: probe.status, resumes }).toEqual({ status: "unknown", resumes: 0 });
});

test("a review crash during admission leaves a pending record that delivery refuses", async () => {
  const { f, env } = await setup();
  const { path, id } = await crashDuringAdmission(f, f.root, () => new CodexRuntime(f.root, env).runReview("Late"));
  const before = count(f.calls, "turn/start");

  const delivery = await new CodexRuntime(f.root, env)
    .startAgent({ runtime: "codex", id }, { prompt: "after crash" })
    .then(
      () => "delivered",
      () => "refused",
    );

  const turns = count(f.calls, "turn/start") - before;
  const admission = read(path)["admission"];
  console.info("REVIEW_CRASH_RECORD", { admission, delivery, turns });
  expect({ admission, delivery, turns }).toEqual({ admission: "pending", delivery: "refused", turns: 0 });
});

test("a refused admission commit archives the pending thread with the refusal kept primary", async () => {
  const { f, home, managed } = await setup();
  f.config.statusObserver = () => {
    const [path] = records(home);
    if (!path) return;
    const { admission: _admission, ...changed } = read(path);
    writeFileSync(path, JSON.stringify({ ...changed, uncertain: "changed by another writer" }));
  };
  const archives = f.config.closes.length;

  const message = await new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }).then(
    () => "admitted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  const [path] = records(home);
  const record = path ? read(path) : {};
  console.info("COMMIT_REFUSAL_CLEANUP", {
    message,
    closes: f.config.closes.slice(archives),
    closed: record["closed"],
  });
  expect(message).toContain("changed before admission was committed");
  expect({ closes: f.config.closes.slice(archives), closed: record["closed"] }).toEqual({
    closes: ["thread/archive"],
    closed: true,
  });
});

test("duty refresh archives a crash-left pending record even when its recorded pid was reused", async () => {
  const { f, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const unrelated = Bun.spawn(["/bin/cat"], { stdin: "pipe", stdout: "ignore" });
  onTestFinished(async () => {
    unrelated.kill();
    await unrelated.exited;
  });
  writeFileSync(`${path}.submit-lock`, JSON.stringify({ pid: unrelated.pid, host: hostname(), at: Date.now() }));
  const archives = f.config.closes.length;
  const resumes = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const result = {
    closes: f.config.closes.slice(archives),
    resumes: count(f.calls, "thread/resume") - resumes,
    closed: read(path)["closed"],
  };
  console.info("CRASHED_ADMITTER_RECOVERY", result);
  expect(result).toEqual({ closes: ["thread/archive"], resumes: 0, closed: true });
});

test("duty refresh skips a pending record whose admitter still holds the thread", async () => {
  const { f, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const admitter = takeInboxLock(`${path}.submit-lock`, Date.now());
  if (!admitter) throw new TypeError("Could not hold the admission lock");
  onTestFinished(admitter);
  const archives = f.config.closes.length;
  const resumes = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const result = {
    closes: f.config.closes.slice(archives),
    resumes: count(f.calls, "thread/resume") - resumes,
    admission: read(path)["admission"],
  };
  console.info("LIVE_ADMITTER_SKIPPED", result);
  expect(result).toEqual({ closes: [], resumes: 0, admission: "pending" });
});
