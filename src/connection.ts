import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { validThread } from "./sessions.ts";

export type Connection = { mode: "owned" } | { mode: "shared"; endpoint: string; lead: string };
export const OWNED: Connection = { mode: "owned" };

/** Only absolute, local Unix socket paths. No host, URL credentials, query or fragment. */
export function unixPath(endpoint: string): string {
  if (!endpoint.startsWith("ws+unix:///")) throw new Error("connection must be ws+unix:///absolute/socket/path");
  const raw = endpoint.slice("ws+unix://".length);
  let path: string;
  try { path = decodeURIComponent(raw); } catch { throw new Error("invalid Unix endpoint encoding"); }
  if (!isAbsolute(path) || /[\x00-\x20%?#]/.test(path) || normalize(path) !== path || path === "/") throw new Error("invalid Unix socket path");
  return path;
}

export function connection(value: unknown): Connection {
  const c = value as { mode?: unknown; endpoint?: unknown; lead?: unknown };
  if (c?.mode === "owned") return OWNED;
  if (c?.mode !== "shared" || typeof c.endpoint !== "string" || typeof c.lead !== "string" || !validThread(c.lead)) throw new Error("invalid saved connection settings");
  const endpoint = `ws+unix://${unixPath(c.endpoint)}`;
  return { mode: "shared", endpoint, lead: c.lead };
}

export function readConnection(home: string): Connection {
  const path = join(home, "connection.json");
  return existsSync(path) ? connection(JSON.parse(readFileSync(path, "utf8"))) : OWNED;
}

export function saveConnection(home: string, c: Connection): void {
  const path = join(home, "connection.json");
  writeFileSync(path + ".tmp", JSON.stringify(connection(c)) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export function sameConnection(a: Connection, b: Connection): boolean {
  return a.mode === b.mode && (a.mode === "owned" || (b.mode === "shared" && a.endpoint === b.endpoint && a.lead === b.lead));
}
