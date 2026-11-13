import { lstatSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createPersonalTools, requestTools } from "./host-tools.ts";
import { BridgeError } from "./schema.ts";

const path = process.argv[2];
if (!path?.startsWith("/") || process.argv.length !== 3)
  throw new TypeError("Usage: bun native-server.ts /absolute/private/native-task-capability.json");
const file = lstatSync(path);
if (!file.isFile() || (file.mode & 0o077) !== 0) throw new BridgeError(-32001, "private_task_capability_required");
const capability = z
  .object({
    role: z.literal("dot"),
    thread_id: z.string().min(1).max(128),
    instance: z.string().min(1).max(128),
    configPath: z.string().startsWith("/"),
  })
  .strict()
  .parse(await Bun.file(path).json());
const service = await createPersonalTools({
  configPath: capability.configPath,
  instance: capability.instance,
  binding: { role: "dot" },
});
const server = new Server(
  { name: `personal-codex-dori:${capability.thread_id}`, version: "0.1.0" },
  { capabilities: { tools: {} } },
);
const pending = new Set<Promise<unknown>>();
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...requestTools] }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const operation = service.call(params.name, params.arguments);
  pending.add(operation);
  try {
    const result = await operation;
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof BridgeError || error instanceof z.ZodError)
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof BridgeError ? error.reason : "invalid_arguments" }],
      };
    throw error;
  } finally {
    pending.delete(operation);
  }
});
server.onclose = () => {
  void Promise.allSettled(pending).then(() => service.close());
};
process.stdin.once("end", () => void server.close());
process.once("SIGTERM", () => void server.close());
process.once("SIGINT", () => void server.close());
await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 32768 }));
