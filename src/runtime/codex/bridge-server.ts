import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { defaultDeps } from "../../harness.ts";
import { hooksSettled } from "../../hooks.ts";
import { bridgeTools } from "./bridge-schema.ts";
import { callBridgeTool, parseScope } from "./bridge-tools.ts";
import { object, text } from "./protocol.ts";
import { adapterDescriptors } from "./bridge-adapter.ts";

async function main(): Promise<void> {
  const capability = process.argv[2];
  if (!capability) throw new Error("Missing bridge capability");
  // Lifecycle diagnostics must never contaminate the MCP stdout transport.
  console.log = (...args: readonly unknown[]) => console.error(...args);
  const reply = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    let id: unknown;
    try {
      if (Buffer.byteLength(line) > 65536) throw new Error("MCP request exceeds 64 KiB");
      const request = object(JSON.parse(line));
      id = request["id"];
      if (!("id" in request)) continue;
      if (typeof id !== "number" && typeof id !== "string") throw new Error("Invalid RPC id");
      const method = text(request["method"]);
      const params = object(request["params"] ?? {});
      let result: unknown;
      switch (method) {
        case "initialize":
          initialized = true;
          result = {
            protocolVersion: text(params["protocolVersion"]),
            capabilities: { tools: {} },
            serverInfo: { name: "dori", version: "1" },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list": {
          if (!initialized) throw new Error("MCP not initialized");
          const scope = parseScope(JSON.parse(readFileSync(capability, "utf8")));
          result = { tools: [...bridgeTools(scope.role), ...(await adapterDescriptors(scope))] };
          break;
        }
        case "tools/call": {
          if (!initialized) throw new Error("MCP not initialized");
          const scope = parseScope(JSON.parse(readFileSync(capability, "utf8")));
          try {
            const value = await callBridgeTool(defaultDeps(), scope, text(params["name"]), params["arguments"] ?? {});
            await hooksSettled();
            result = { content: [{ type: "text", text: JSON.stringify(value) }] };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            };
          }
          break;
        }
        default:
          reply({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown MCP method" } });
          continue;
      }
      reply({ jsonrpc: "2.0", id, result });
    } catch (error) {
      reply({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32602, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  await hooksSettled();
  process.exit(0);
}

if (import.meta.main) await main();
