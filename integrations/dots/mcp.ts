import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Events } from "./events.ts";
import type { Jobs } from "./jobs.ts";
import {
  BridgeError,
  EventName,
  Filter,
  JobId,
  type Principal,
  RequestInput,
  Subscribe,
  Unsubscribe,
} from "./schema.ts";
import type { Store } from "./store.ts";

export async function mcp(
  request: Request,
  principal: Principal,
  expires: number,
  store: Store,
  jobs: Jobs,
  events: Events,
): Promise<Response> {
  // SDK 1.x supports extension handlers; its capability type predates the Events draft.
  const capabilities = { tools: {}, events: {} };
  const server = new Server({ name: "dori-dots", version: "0.1.0" }, { capabilities });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "dori_submit_request",
        description:
          "Submit a bounded development request to this Codex Dori lead. Reuse origin_id and request_id for retries.",
        inputSchema: z.toJSONSchema(RequestInput),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "dori_job_status",
        description: "Read a durable Dori job result and lead admission state.",
        inputSchema: z.toJSONSchema(Filter),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      let result: unknown;
      switch (params.name) {
        case "dori_submit_request":
          result = await jobs.submit(principal, RequestInput.parse(params.arguments));
          break;
        case "dori_job_status":
          result = store.job(principal, Filter.parse(params.arguments).job_id);
          break;
        default:
          throw new BridgeError(-32602, "unknown_tool");
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      if (error instanceof BridgeError || error instanceof z.ZodError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof BridgeError ? error.reason : "invalid_arguments",
            },
          ],
        };
      }
      throw error;
    }
  });
  server.setRequestHandler(
    z.object({
      method: z.literal("events/list"),
      params: z.object({ cursor: z.string().optional() }).optional(),
    }),
    async () => ({
      events: EventName.options.map((name) => ({
        name,
        description:
          name === "dori.job.completed" ? "A Dori job completed or failed." : "A Dori job needs a user decision.",
        delivery: ["webhook"],
        inputSchema: z.toJSONSchema(Filter),
        payloadSchema: {
          type: "object",
          properties: {
            job_id: z.toJSONSchema(JobId),
            origin_id: { type: "string" },
            request_id: { type: "string" },
            state: { type: "string" },
            summary: { type: "string" },
            thread_id: { type: "string" },
            revision: { type: "integer" },
          },
          required: ["job_id", "origin_id", "request_id", "state", "summary", "thread_id", "revision"],
          additionalProperties: false,
        },
      })),
    }),
  );
  server.setRequestHandler(
    z.object({ method: z.literal("events/subscribe"), params: Subscribe }),
    async ({ params }) => {
      try {
        return await events.subscribe(principal, params, expires);
      } catch (error) {
        if (error instanceof BridgeError)
          throw new McpError(error.code, error.reason, {
            reason: error.reason,
          });
        throw error;
      }
    },
  );
  server.setRequestHandler(
    z.object({ method: z.literal("events/unsubscribe"), params: Unsubscribe }),
    async ({ params }) => {
      events.unsubscribe(principal, params);
      return {};
    },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: 32768,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  // JSON mode has no response stream left open after handleRequest returns.
  await server.close();
  return response;
}
