import { array, type CodexConnection, CodexError, object } from "./protocol.ts";

/**
 * Managed and review threads expose no MCP server from any Codex config layer. The app-server resolves every layer
 * for the exact thread cwd, including untrusted project layers it disables, and each declared server is overridden
 * for this thread only; no config file is edited. A failed read or unexpected shape refuses the thread start.
 * The legacy managed_config layer outranks thread overrides and remains an operator-owned residual.
 */
export const disabledConfiguredMcpServers = async (
  connection: CodexConnection,
  cwd: string,
  reservedName?: string,
): Promise<Record<string, { enabled: false }>> => {
  const response = object(await connection.call("config/read", { cwd, includeLayers: true }));
  const configs = [response["config"], ...array(response["layers"]).map((layer) => object(layer)["config"])];
  if (reservedName) {
    for (const config of configs) {
      const candidates = [config, ...Object.values(object(object(config)["profiles"] ?? {}))];
      for (const candidate of candidates)
        if (Object.hasOwn(object(object(candidate)["mcp_servers"] ?? {}), reservedName))
          throw new CodexError(
            "unsupported",
            `Configured MCP server conflicts with reserved management name: ${reservedName}`,
          );
    }
  }
  const names = new Set(configs.flatMap((config) => Object.keys(object(object(config)["mcp_servers"] ?? {}))));
  return Object.fromEntries([...names].map((name) => [name, { enabled: false as const }]));
};
