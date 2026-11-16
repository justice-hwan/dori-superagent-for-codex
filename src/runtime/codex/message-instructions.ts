import { realpathSync } from "node:fs";
import type { CreateSpec } from "../types.ts";
import { adapterDescriptors } from "./bridge-adapter.ts";
import { bridgeTools } from "./bridge-schema.ts";
import { CodexError } from "./protocol.ts";

export async function messageInstructions(root: string, spec: CreateSpec, id = ""): Promise<string> {
  const role = spec.role;
  if (role !== "lead" && role !== "lane" && role !== "duty")
    throw new CodexError("unsupported", "Workers do not issue management messages");
  const scope = { root: realpathSync(root), cwd: realpathSync(spec.cwd), role, key: spec.env["DORI_LANE"] || "", id };
  const tools = [...bridgeTools(role), ...(await adapterDescriptors(scope))];
  const example =
    role === "lane"
      ? { version: 1, kind: "action", tool: "dori_report", arguments: { text: "Progress update", status: "working" } }
      : { version: 1, kind: "action", tool: "dori_status", arguments: {} };
  return `This is a real Codex Dori ${role} reasoning thread. A host controller handles management messages.
For harness operations use only the allowed management names below. Do not invoke a management MCP server, CLI or shell workaround.
This protocol replaces CLI and MCP management examples in role instructions or briefs; those examples do not grant another transport or caller scope.
Perform ordinary task work with the normal sandboxed task tools. When management is needed, finish your turn with exactly one raw JSON object, no markdown or surrounding prose.
The message schema is version 1, kind action, tool and arguments. Caller identity, home, thread, role and workspace are host-owned; never supply them.
Allowed operations and their exact argument schemas: ${JSON.stringify(tools)}
A valid example for your role is: ${JSON.stringify(example)}
After an actual dori_receipt, continue the task. A further management request ends a NEW turn and is validated separately; otherwise answer in ordinary prose, which may be empty when no reply is needed.
Receipt acknowledgment means completed delivery of that exact receipt input, not agreement or operation success; operation success is the receipt ok field.
Never repeat an uncertain or already consumed action. A refusal does not prove that partial effects were rolled back; inspect status instead of blindly repeating.
Lane READY requires real evidence and is terminal: its receipt settles locally, without another lane turn. Lead reports arrive through the identified inbox.
Desktop ownership pauses controller dispatch. Never claim control or request takeback, archive, credentials, configuration or route changes.`;
}
