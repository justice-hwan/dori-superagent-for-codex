import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { record } from "./codex-transport.ts";
import { ConfigError } from "./select.ts";

export type NativeSettings = {
  readonly socket: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly fullAccess?: boolean;
};

export type NativePolicy = Readonly<Record<string, unknown>>;

/** Preserve returned policy as evidence, including unsupported or missing admission fields. */
export function nativePolicy(response: Record<string, unknown>): NativePolicy {
  return {
    sandbox: response["sandbox"],
    approvalPolicy: response["approvalPolicy"],
    activePermissionProfile: response["activePermissionProfile"],
    runtimeWorkspaceRoots: response["runtimeWorkspaceRoots"],
  };
}

export function hasFullAccess(policy: NativePolicy | undefined): boolean {
  const sandbox = policy?.["sandbox"];
  return (
    record(sandbox) &&
    sandbox["type"] === "dangerFullAccess" &&
    Object.keys(sandbox).length === 1 &&
    policy?.["approvalPolicy"] === "never"
  );
}

/** Per-instance settings only. There is deliberately no discovered/default daemon socket. */
export function nativeSettings(root: string, env: Readonly<Record<string, string | undefined>>): NativeSettings {
  const path = join(root, "config.json");
  let raw: unknown = {};
  try {
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new ConfigError(`${path} is not valid JSON`);
    throw error;
  }
  if (!record(raw)) throw new ConfigError(`${path} must contain an object`);
  const config = raw["codex"];
  if (config !== undefined && !record(config)) throw new ConfigError(`${path}: codex must be an object`);
  const socket = env["DORI_CODEX_SOCKET"] || (record(config) ? config["socket"] : undefined);
  const model = env["DORI_CODEX_MODEL"] || (record(config) ? config["model"] : undefined);
  const timeoutMs = record(config) ? (config["timeoutMs"] ?? 5000) : 5000;
  const turnTimeoutMs = record(config) ? (config["turnTimeoutMs"] ?? 180000) : 180000;
  const fullAccess = record(config) ? config["fullAccess"] : undefined;
  if (fullAccess !== undefined && typeof fullAccess !== "boolean")
    throw new ConfigError(`${path}: codex.fullAccess must be a boolean`);
  if (typeof socket !== "string" || !isAbsolute(socket))
    throw new ConfigError("native runtime requires an explicit absolute codex.socket or DORI_CODEX_SOCKET");
  if (typeof model !== "string" || !model.startsWith("gpt-"))
    throw new ConfigError("native runtime requires an explicit GPT codex.model or DORI_CODEX_MODEL");
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    typeof turnTimeoutMs !== "number" ||
    !Number.isFinite(turnTimeoutMs) ||
    turnTimeoutMs <= 0
  )
    throw new ConfigError("native connection and turn deadlines must be finite positive milliseconds");
  return { socket, model, timeoutMs, turnTimeoutMs, fullAccess: fullAccess === true };
}
