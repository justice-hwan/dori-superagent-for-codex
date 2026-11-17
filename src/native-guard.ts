import { createHash } from "node:crypto";
import { chmodSync, existsSync, realpathSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { Refusal } from "./refusal.ts";
import { record } from "./runtime/codex-transport.ts";

/** The OS binding, not a pid file, is the authority. A stale socket fails closed; never unlink it to take over. */
function guardPath(home: string, key: string): string {
  const hash = createHash("sha256")
    .update(`${realpathSync(home)}\0${key}`)
    .digest("hex")
    .slice(0, 32);
  return `/tmp/dori-native-${process.getuid?.() ?? "user"}-${hash}.sock`;
}

export async function nativeGuard(home: string, key: string, snapshot: () => object = () => ({ pid: process.pid })) {
  const server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.end(`${JSON.stringify(snapshot())}\n`, () => socket.destroy());
  });
  const path = guardPath(home, key);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Refusal(
      `native ${key} guard unavailable; another owner or stale socket must be resolved (${error.message})`,
    );
  }
  return {
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

/** A read-only live response. No PID-based success, stale-file removal, RPC, or status heartbeat write. */
export async function nativeHostStatus(home: string): Promise<string> {
  if (!existsSync(home)) return "HOST stopped";
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(guardPath(home, "host"));
      let text = "";
      socket.setTimeout(1000, () => socket.destroy(new Error("host status deadline")));
      socket.on("data", (data) => {
        text += data.toString();
        if (text.length > 4096) socket.destroy(new Error("host status exceeds limit"));
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(text));
    });
    const value: unknown = JSON.parse(text);
    if (
      !record(value) ||
      typeof value["phase"] !== "string" ||
      typeof value["pid"] !== "number" ||
      typeof value["duty"] !== "string" ||
      typeof value["hourly"] !== "string"
    )
      return "HOST unknown";
    return `HOST ${value["phase"]} pid=${value["pid"]} duty=${value["duty"]} hourly=${value["hourly"]}`;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if ("code" in error && error.code === "ENOENT") return "HOST stopped";
    if ("code" in error && error.code === "ECONNREFUSED") return "HOST stale (guard is not a live host)";
    return `HOST unknown: ${error.message}`;
  }
}
