import { resolve } from "node:path";
import { z } from "zod";
import { BridgeError } from "./schema.ts";

const Config = z
  .object({
    instance: z.string().min(1).max(128),
    directory: z.string().startsWith("/"),
    oauth: z.object({ resource: z.url(), issuer: z.url(), jwksUrl: z.url() }).strict().optional(),
    principalFile: z.string().startsWith("/"),
    localPrincipal: z.string().min(1).max(128),
    runtimeHome: z.string().startsWith("/"),
    runtimeCommand: z.array(z.string().min(1)).min(1),
    port: z.number().int().min(1024).max(65535).default(8766),
  })
  .strict();
export async function loadConfig(path = process.env["DORI_DOTS_CONFIG"]) {
  if (!path) throw new BridgeError(-32001, "DORI_DOTS_CONFIG_required");
  if (!path.startsWith("/")) throw new BridgeError(-32001, "absolute_config_path_required");
  const config = Config.parse(await Bun.file(path).json());
  if (!config.runtimeCommand[0]?.startsWith("/")) throw new BridgeError(-32001, "absolute_runtime_command_required");
  return {
    ...config,
    runtimeCommand: [
      "/usr/bin/env",
      `DORI_HOME=${config.runtimeHome}`,
      "DORI_RUNTIME=codex",
      `BUN_BIN=${process.execPath}`,
      "BUN_BE_BUN=1",
      ...config.runtimeCommand,
    ],
    configPath: path,
    database: resolve(config.directory, "dots.sqlite"),
    socket: resolve(config.directory, "wake.sock"),
    outcomeCommand: [
      "/usr/bin/env",
      `DORI_DOTS_CONFIG=${path}`,
      "BUN_BE_BUN=1",
      process.execPath,
      resolve(import.meta.dir, "cli.ts"),
      "update",
    ],
  };
}
