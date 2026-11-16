import { Refusal } from "../../refusal.ts";
import { object, text } from "./protocol.ts";

export type BridgeRole = "lead" | "lane" | "duty";
export const bridgeTools = (role: BridgeRole) => {
  const string = { type: "string", minLength: 1, maxLength: 32768 };
  const tool = (name: string, description: string, properties: object, required: readonly string[]) => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  });
  const status = tool("dori_status", "Inspect this fixed Dori instance's lanes.", {}, []);
  switch (role) {
    case "lead":
      return [
        status,
        tool(
          "dori_start",
          "Create one lane in the fixed workspace from bounded brief content.",
          { key: string, brief: string },
          ["key", "brief"],
        ),
        tool(
          "dori_send",
          "Send an instruction to one owned lane; busy/desktop admission stays queued.",
          { key: string, text: string },
          ["key", "text"],
        ),
        tool("dori_done", "Close a READY and idle lane after inspecting its evidence.", { key: string }, ["key"]),
      ];
    case "lane":
      return [
        tool(
          "dori_report",
          "Report progress for your own lane to its lead.",
          {
            text: string,
            status: { enum: ["working", "waiting"] },
          },
          ["text"],
        ),
        tool(
          "dori_ready",
          "Submit your own lane's completed answer with evidence to its lead.",
          {
            text: string,
            evidence: { type: "array", minItems: 1, maxItems: 16, items: string },
          },
          ["text", "evidence"],
        ),
      ];
    case "duty":
      return [status];
  }
};

export const argumentsOf = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  const args = object(value);
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Refusal("Unknown management tool argument");
  return args;
};
export const boundedText = (value: unknown, limit = 32768): string => {
  const result = text(value);
  if (!result.trim() || Buffer.byteLength(result) > limit) throw new Refusal("Management text is empty or too large");
  return result;
};
