import { onTestFinished } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { object } from "../../src/runtime/codex/protocol.ts";
import { CodexStore } from "../../src/runtime/codex/store.ts";
import { fixture } from "../codex-fixture.test.ts";

export const setup = async () => {
  const f = await fixture();
  const codexHome = join(dirname(f.root), "codex-home");
  mkdirSync(codexHome);
  writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.user_reader]\ncommand = "/usr/bin/true"\n');
  const home = mkdtempSync(join(homedir(), ".dori-pending-readers-"));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...f.env, CODEX_HOME: codexHome, DORI_CODEX_WORKSPACE: f.spec.cwd };
  const managed = {
    ...env,
    DORI_HOME: home,
    DORI_RUNTIME: "codex",
    BUN_BIN: process.execPath,
    DORI_CODEX_BRIDGE: "stdio",
  };
  return { f, env, home, managed };
};
export const records = (root: string) => {
  const directory = dirname(new CodexStore(root).path(crypto.randomUUID()));
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(directory, name));
};
export const read = (path: string) => object(JSON.parse(readFileSync(path, "utf8")));
export const count = (calls: readonly string[], method: string) => calls.filter((call) => call === method).length;

/** Leaves the record exactly as it stood on disk while the admission check ran, as a crash at that moment would. */
export const crashDuringAdmission = async (
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

