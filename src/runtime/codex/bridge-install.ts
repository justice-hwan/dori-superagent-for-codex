import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CreateSpec } from "../types.ts";
import { bridgeTools, type BridgeRole } from "./bridge-schema.ts";
import { CodexError, object } from "./protocol.ts";
import type { Environment } from "./threads.ts";
import { adapterConfig } from "./bridge-jobs.ts";

const source = resolve(import.meta.dir, "../../..");
const snapshots = new Map<string, string>();
const within = (child: string, parent: string) => {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !path.startsWith("/"))
  );
};
/** All executable code and authority state must be outside native tool write roots. */
export const trustedPath = (path: string, cwd: string): string => {
  if (!isAbsolute(path)) throw new CodexError("ownership", "Bridge paths must be absolute");
  const real = realpathSync(path);
  const roots = [realpathSync(cwd), realpathSync(tmpdir()), realpathSync("/tmp")];
  if (roots.some((root) => within(real, root)))
    throw new CodexError(
      "ownership",
      "Bridge code, executable and home must be outside agent-writable workspace and temporary roots",
    );
  return real;
};

function snapshot(base: string): string {
  const cached = snapshots.get(base);
  if (cached) return cached;
  const names = [
    ...new Bun.Glob("src/**/*.ts").scanSync({ cwd: source }),
    ...new Bun.Glob("prompts/**/*.md").scanSync({ cwd: source }),
    "scripts/dori-codex.sh",
    "package.json",
    "LICENSE",
  ].sort();
  const files = names.map((name) => ({ name, content: readFileSync(join(source, name)) }));
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of files) hash.update(file.name).update("\0").update(file.content);
  const version = hash.digest("hex");
  const directory = join(base, version);
  if (!existsSync(join(directory, ".complete"))) {
    const temporary = mkdtempSync(join(base, ".install-"));
    try {
      for (const file of files) {
        const path = join(temporary, file.name);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, file.content, { mode: 0o400 });
      }
      writeFileSync(join(temporary, ".complete"), version, { mode: 0o400 });
      try {
        renameSync(temporary, directory);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code)))
          throw error;
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  snapshots.set(base, directory);
  return directory;
}

export const prepareBridge = (root: string, spec: CreateSpec, env: Environment) => {
  if (spec.role !== "lead" && spec.role !== "lane" && spec.role !== "duty")
    throw new CodexError("unsupported", "No bridge for workers");
  if (env["DORI_CODEX_SANDBOX"] && env["DORI_CODEX_SANDBOX"] !== "workspace-write")
    throw new CodexError("unsupported", "The management bridge requires workspace-write");
  const role: BridgeRole = spec.role;
  const cwd = realpathSync(spec.cwd);
  const home = trustedPath(root, cwd);
  const executable = trustedPath(env["BUN_BIN"] || process.execPath, cwd);
  const base = join(homedir(), ".local/share/dori/codex-bridge");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  trustedPath(base, cwd);
  const installed = snapshot(base);
  const capabilities = join(base, "capabilities");
  mkdirSync(capabilities, { recursive: true, mode: 0o700 });
  const path = join(capabilities, `${crypto.randomUUID()}.json`);
  const scope = { root: home, cwd, role, key: spec.env["DORI_LANE"] || "", id: "" };
  writeFileSync(path, JSON.stringify(scope), { mode: 0o600, flag: "wx" });
  const names = bridgeTools(role).map((tool) => tool.name);
  if (role === "lead" && adapterConfig(home)) names.push("dori_job_status", "dori_report_outcome");
  // Managed roles expose their fixed management server, not unrelated user MCP
  // processes. This is a per-thread override; the user's config is never edited.
  const codexConfig = join(env["CODEX_HOME"] || join(env["HOME"] || homedir(), ".codex"), "config.toml");
  const inherited: Record<string, unknown> = existsSync(codexConfig)
    ? object(Bun.TOML.parse(readFileSync(codexConfig, "utf8")))
    : {};
  const disabled = Object.fromEntries(
    Object.keys(object(inherited["mcp_servers"] ?? {})).map((name) => [name, { enabled: false }]),
  );
  return {
    config: {
      sandbox_workspace_write: { writable_roots: [], exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
      mcp_servers: {
        ...disabled,
        dori: {
          command: executable,
          args: [join(installed, "src/runtime/codex/bridge-server.ts"), path],
          cwd: home,
          enabled_tools: names,
          startup_timeout_sec: 15,
          tool_timeout_sec: 60,
          tools: Object.fromEntries(names.map((name) => [name, { approval_mode: "approve" }])),
          env: {
            DORI_HOME: home,
            DORI_RUNTIME: "codex",
            DORI_CODEX_BRIDGE: "stdio",
            BUN_BIN: executable,
            DORI_CMD: `/bin/sh "${join(installed, "scripts/dori-codex.sh")}"`,
            DORI_CODEX_MODEL: env["DORI_CODEX_MODEL"] || "gpt-6.1-sol",
            DORI_CODEX_SANDBOX: "workspace-write",
            DORI_CODEX_APPROVAL_POLICY: env["DORI_CODEX_APPROVAL_POLICY"] || "on-request",
            ...(env["DORI_CODEX_SOCKET"] ? { DORI_CODEX_SOCKET: env["DORI_CODEX_SOCKET"] } : {}),
          },
        },
      },
    },
    bind(id: string) {
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify({ ...scope, id }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    },
    discard() {
      rmSync(path);
    },
  };
};
