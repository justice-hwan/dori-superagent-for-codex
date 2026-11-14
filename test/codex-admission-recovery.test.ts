import { expect, onTestFinished, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { CodexConnection, object } from "../src/runtime/codex/protocol.ts";
import { runReview } from "../src/runtime/codex/review.ts";
import { CodexStore, type RecordEntry } from "../src/runtime/codex/store.ts";
import { fixture } from "./codex-fixture.test.ts";

const setup = async () => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.user_reader]\ncommand = "/usr/bin/true"\n');
  const home = mkdtempSync(join(homedir(), ".dori-admission-recovery-"));
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
const sessions = (root: string) => dirname(new CodexStore(root).path(crypto.randomUUID()));
const records = (root: string) =>
  readdirSync(sessions(root))
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(sessions(root), name));

class FailingStore extends CodexStore {
  override async save(entry: RecordEntry): Promise<void> {
    if (entry.closed || entry.uncertain?.includes("archiving")) throw new Error("disk full");
    await super.save(entry);
  }
}

test.each(["ok", "fail"] as const)("a refusal stays primary when persistence fails; archive=%s", async (closeMode) => {
  const { f, env } = await setup();
  f.config.lateServer = "late_writer";
  f.config.closeMode = closeMode;
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());

  const error = await runReview(new FailingStore(f.root), connection, env, "Late").then(
    () => undefined,
    (reason: unknown) => reason,
  );

  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const secondary = cause instanceof AggregateError ? cause.errors : [cause];
  console.info("REFUSAL_PERSISTENCE_FAILURE", {
    closeMode,
    message,
    secondary: secondary.map((item) => (item instanceof Error ? item.message : String(item))),
  });
  expect(message).toContain("unexpected MCP servers");
  expect(secondary.map((item) => (item instanceof Error ? item.message : String(item)))).toEqual(
    closeMode === "ok" ? ["disk full"] : ["thread/archive failed", "disk full"],
  );
});

test("a crash during admission leaves a record that later delivery refuses and close archives", async () => {
  const { f, home, managed } = await setup();
  f.config.lateServer = "late_writer";
  let crashed: { readonly path: string; readonly content: string } | undefined;
  f.config.statusObserver = () => {
    const [path] = records(home);
    if (path) crashed = { path, content: readFileSync(path, "utf8") };
  };
  await new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }).catch(() => undefined);
  if (!crashed) throw new TypeError("No record existed during admission");
  writeFileSync(crashed.path, crashed.content);
  const id = String(object(JSON.parse(crashed.content))["id"]);
  const before = f.calls.filter((call) => call === "turn/start").length;
  const archives = f.config.closes.length;

  const recovered = new CodexRuntime(home, managed);
  const delivery = await recovered.startAgent({ runtime: "codex", id }, { prompt: "after crash" }).then(
    () => "delivered",
    () => "refused",
  );
  const turns = f.calls.filter((call) => call === "turn/start").length - before;
  await recovered.close({ runtime: "codex", id });

  const record = object(JSON.parse(readFileSync(crashed.path, "utf8")));
  console.info("PENDING_ADMISSION_RECOVERY", {
    delivery,
    turns,
    closes: f.config.closes.slice(archives),
    closed: record["closed"],
  });
  expect({ delivery, turns, closes: f.config.closes.slice(archives), closed: record["closed"] }).toEqual({
    delivery: "refused",
    turns: 0,
    closes: ["thread/archive"],
    closed: true,
  });
});

test("committing admission never overwrites a record recovery changed in between", async () => {
  const { f, home, managed } = await setup();
  f.config.statusObserver = () => {
    const [path] = records(home);
    if (!path) return;
    writeFileSync(path, JSON.stringify({ ...object(JSON.parse(readFileSync(path, "utf8"))), closed: true }));
  };

  const outcome = await new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }).then(
    () => "admitted",
    () => "refused",
  );

  const closed = records(home).map((path) => object(JSON.parse(readFileSync(path, "utf8")))["closed"]);
  console.info("ADMISSION_COMMIT_RACE", { outcome, closed });
  expect({ outcome, closed }).toEqual({ outcome: "refused", closed: [true] });
});

test("no other operation can take the thread submit lock during the admission window", async () => {
  const { f, home, managed } = await setup();
  let held: (() => void) | undefined;
  f.config.statusObserver = () => {
    const [path] = records(home);
    if (path) held = takeInboxLock(`${path}.submit-lock`, Date.now());
  };

  const outcome = await new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }).then(
    () => "admitted",
    () => "refused",
  );
  const lockHeld = held !== undefined;
  held?.();

  const pending = records(home).map((path) => object(JSON.parse(readFileSync(path, "utf8")))["admission"]);
  console.info("ADMISSION_COMMIT_LOCKED", { outcome, lockHeld, pending });
  expect({ outcome, lockHeld, pending }).toEqual({ outcome: "admitted", lockHeld: false, pending: [undefined] });
});
