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
  projectTrusted = true;
  readonly reads: Record<string, unknown>[] = [];

  constructor(private readonly directory: string) {}

  read(params: Record<string, unknown>): { readonly error: string } | { readonly result: Record<string, unknown> } {
    this.reads.push(params);
    return configReadOutcome(this.directory, params, this.mode, this.projectTrusted);
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
