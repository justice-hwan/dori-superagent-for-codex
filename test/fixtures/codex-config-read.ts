import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { object } from "../../src/runtime/codex/protocol.ts";


/**
 * Models app-server `config/read` for one fixture directory: project `.codex/config.toml` layers from `cwd` up to the
 * fixture root (highest precedence first), then the fixture user layer. Only fixture-owned files are read, never a
 * real Codex home. Untrusted project layers are returned with `disabledReason` and left out of the effective config.
 */
export class FixtureConfigRead {
  mode: "layers" | "fail" | "malformed" = "layers";
  statusMode: "list" | "fail" | "malformed" | "hang" = "list";
  projectTrusted = true;
  lateServer: string | undefined;
  readonly reads: Record<string, unknown>[] = [];
  readonly statusReads: Record<string, unknown>[] = [];
  closeMode: "ok" | "fail" = "ok";
  readonly closes: string[] = [];
  statusObserver: (() => void) | undefined;
  closeObserver: ((method: string) => void) | undefined;

  /** Answers the methods this fake owns; a failing close mode rejects both thread/archive and thread/unsubscribe. */
  handle(
    method: string,
    params: Record<string, unknown>,
    started: Record<string, unknown>,
  ): "hang" | undefined | { readonly error: string } | { readonly result: Record<string, unknown> } {
    if (method === "config/read") return this.read(params);
    if (method === "mcpServerStatus/list") return this.status(params, started);
    if (method !== "thread/archive" && method !== "thread/unsubscribe") return undefined;
    this.closes.push(method);
    this.closeObserver?.(method);
    if (this.closeMode === "fail") return { error: `${method} failed` };
    return method === "thread/archive" ? { result: {} } : undefined;
  }

  constructor(private readonly directory: string) {}

  read(params: Record<string, unknown>): { readonly error: string } | { readonly result: Record<string, unknown> } {
    this.reads.push(params);
    const outcome = configReadOutcome(this.directory, params, this.mode, this.projectTrusted);
    if (this.reads.length < 2 || !this.lateServer || !("result" in outcome)) return outcome;
    const config = object(outcome.result["config"]);
    const servers = { ...object(config["mcp_servers"] ?? {}), [this.lateServer]: { command: "/usr/bin/true" } };
    const late = { name: { type: "user", file: "late" }, version: "late", config: { mcp_servers: servers } };
    const layers = outcome.result["layers"] === undefined ? undefined : [...(outcome.result["layers"] as unknown[]), late];
    return { result: { ...outcome.result, config: { ...config, mcp_servers: servers }, ...(layers ? { layers } : {}) } };
  }

  /** Thread-scoped status: every configured server plus the thread's own, `disabled` when the thread start disabled it. */
  status(
    params: Record<string, unknown>,
    started: Record<string, unknown>,
  ): "hang" | { readonly error: string } | { readonly result: Record<string, unknown> } {
    this.statusReads.push(params);
    this.statusObserver?.();
    if (this.statusMode === "hang") return "hang";
    if (this.statusMode === "fail") return { error: "MCP status unavailable" };
    if (this.statusMode === "malformed") return { result: { data: "unparseable" } };
    const configured = configReadOutcome(this.directory, { cwd: started["cwd"] }, "layers", this.projectTrusted);
    const effective = "result" in configured ? object(object(configured.result["config"])["mcp_servers"] ?? {}) : {};
    const own = object(object(started["config"] ?? {})["mcp_servers"] ?? {});
    const names = new Set([...Object.keys(effective), ...Object.keys(own), ...(this.lateServer ? [this.lateServer] : [])]);
    const data = [...names].map((name) => ({
      name,
      runtimeStatus: object(own[name] ?? {})["enabled"] === false ? "disabled" : "connected",
    }));
    return { result: { data, nextCursor: null } };
  }
}

const configReadOutcome = (
  directory: string,
  params: Record<string, unknown>,
  mode: FixtureConfigRead["mode"],
  projectTrusted: boolean,
): { readonly error: string } | { readonly result: Record<string, unknown> } => {
  if (mode === "fail") return { error: "Failed to read configuration layers" };
  if (mode === "malformed") return { result: { config: "unparseable" } };
  const sources: { name: Record<string, unknown>; path: string; disabled: boolean }[] = [];
  for (let dir = String(params["cwd"] ?? ""); dir.startsWith(directory); dir = dirname(dir)) {
    const dotCodexFolder = join(dir, ".codex");
    sources.push({ name: { type: "project", dotCodexFolder }, path: join(dotCodexFolder, "config.toml"), disabled: !projectTrusted });
    if (dir === directory) break;
  }
  const userFile = join(directory, "codex-home", "config.toml");
  sources.push({ name: { type: "user", file: userFile }, path: userFile, disabled: false });
  const layers = sources
    .filter((source) => existsSync(source.path))
    .map((source) => ({
      name: source.name,
      version: "fixture",
      config: object(Bun.TOML.parse(readFileSync(source.path, "utf8"))),
      ...(source.disabled ? { disabledReason: "untrusted project" } : {}),
    }));
  const servers = Object.assign(
    {},
    ...layers
      .filter((layer) => !("disabledReason" in layer))
      .reverse()
      .map((layer) => object(layer.config["mcp_servers"] ?? {})),
  );
  return {
    result: { config: { mcp_servers: servers }, origins: {}, ...(params["includeLayers"] ? { layers } : {}) },
  };
};
