import { mkdirSync, mkdtempSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { prepareBridge } from "../../src/runtime/codex/bridge-install.ts";

if (import.meta.main) {
  const base = join(homedir(), ".local/share/dori/codex-bridge");
  const home = join(homedir(), "authority");
  const workspace = join(homedir(), "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const spec = { name: "lane", role: "lane" as const, container: "tab" as const, cwd: workspace, env: { DORI_LANE: "audit" } };
  const initial = prepareBridge(home, spec, { BUN_BIN: process.execPath });
  const installed = dirname(dirname(dirname(dirname(String(initial.config.mcp_servers.dori.args[0])))));
  initial.discard();
  const mode = process.argv[2];
  let cwd = workspace;
  if (mode === "capabilities") cwd = join(base, "capabilities");
  if (mode === "nested-capabilities") cwd = mkdtempSync(join(base, "capabilities/workspace-"));
  if (mode === "snapshot") cwd = installed;
  if (mode === "symlink-capabilities") {
    renameSync(join(base, "capabilities"), join(base, "old-capabilities"));
    symlinkSync(workspace, join(base, "capabilities"), "dir");
  }
  if (mode === "symlink-snapshot") {
    renameSync(installed, `${installed}.original`);
    symlinkSync(workspace, installed, "dir");
  }
  try {
    const result = prepareBridge(home, { ...spec, cwd }, { BUN_BIN: process.execPath });
    result.discard();
    console.log(JSON.stringify({ accepted: true }));
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, kind: error instanceof Error && "kind" in error ? error.kind : "other" }));
  }
}
