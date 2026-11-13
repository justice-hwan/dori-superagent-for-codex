import { chmodSync, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Auth } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { Events } from "./events.ts";
import { Jobs } from "./jobs.ts";
import { mcp } from "./mcp.ts";
import { BridgeError } from "./schema.ts";
import { Store } from "./store.ts";

const config = await loadConfig();
if (!config.oauth) throw new BridgeError(-32001, "oauth_configuration_required_for_MCP");
process.umask(0o077);
mkdirSync(config.directory, { recursive: true, mode: 0o700 });
chmodSync(config.directory, 0o700);
const lockPath = join(config.directory, "bridge.lock");
const lock = openSync(lockPath, "wx", 0o600);
const store = new Store(config.database, config.instance);
const auth = new Auth({ ...config.oauth, principalFile: config.principalFile });
const events = new Events(store, (principal) => auth.allowed(principal));
const jobs = new Jobs(store, config.runtimeCommand, () => events.drain(), config.outcomeCommand, config.configPath);
await jobs.recover();
await events.drain();
const resource = new URL(config.oauth.resource);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.has("origin") && request.headers.get("origin") !== "https://chatgpt.com") {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
      return Response.json(auth.metadata());
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    try {
      const identity = await auth.authenticate(request);
      return await mcp(request, identity.principal, identity.expires * 1000, store, jobs, events);
    } catch (error) {
      if (error instanceof BridgeError && error.code === -32001) {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resource.origin}/.well-known/oauth-protected-resource", scope="dori:jobs"`,
          },
        });
      }
      console.error("Dots request failed", error instanceof Error ? error.name : "unknown");
      return new Response("Request failed", { status: 500 });
    }
  },
});
// This listener is never exposed through the reverse proxy. Its filesystem is the local authorization boundary.
const wake = Bun.serve({
  unix: config.socket,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wake") {
      return new Response("Not found", { status: 404 });
    }
    await events.drain();
    return new Response("OK");
  },
});
chmodSync(config.socket, 0o600);
console.log(`Dots bridge listening on loopback port ${app.port}; instance ${config.instance}`);
function stop(): void {
  app.stop(true);
  wake.stop(true);
  events.close();
  store.close();
  closeSync(lock);
  unlinkSync(lockPath);
  process.exit(0);
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
