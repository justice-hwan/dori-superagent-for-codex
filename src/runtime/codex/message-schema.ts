import { boundedText, argumentsOf } from "./bridge-schema.ts";
import { array, type CodexConnection, CodexError, object, text } from "./protocol.ts";

export type MessageSource = { readonly threadId: string; readonly turnId: string; readonly itemId: string };
export type ManagementAction = { readonly tool: string; readonly arguments: Record<string, unknown> };
export type ManagementFinal = { readonly source: MessageSource; readonly action: ManagementAction };

export function parseManagementAction(content: string): ManagementAction | undefined {
  if (!content.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CodexError("protocol", "Malformed management JSON final");
    throw error;
  }
  const value = object(parsed);
  if (value["kind"] !== "action") return undefined;
  if (Buffer.byteLength(content) > 65536) throw new CodexError("protocol", "Management final exceeds 64 KiB");
  const request = argumentsOf(value, ["version", "kind", "tool", "arguments"]);
  if (request["version"] !== 1) throw new CodexError("protocol", "Unsupported management message version");
  return { tool: boundedText(request["tool"], 128), arguments: object(request["arguments"]) };
}

export function managementFinal(threadId: string, turn: Record<string, unknown>): ManagementFinal | undefined {
  if (turn["status"] !== "completed" || turn["error"] != null) return undefined;
  const finals = array(turn["items"])
    .map(object)
    .filter((item) => item["type"] === "agentMessage" && item["phase"] === "final_answer");
  if (finals.length > 1) throw new CodexError("protocol", "Multiple canonical final answers");
  const final = finals[0];
  if (!final) return undefined;
  const action = parseManagementAction(text(final["text"]));
  return action
    ? { action, source: { threadId, turnId: boundedText(turn["id"], 256), itemId: boundedText(final["id"], 256) } }
    : undefined;
}

/** Stop at the last observed turn so long-lived roles do not repeatedly scan their entire history. */
export async function unseenTurns(
  connection: CodexConnection,
  id: string,
  seen: (turn: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  const pending: Record<string, unknown>[] = [];
  let cursor: unknown = null;
  for (let page = 0; page < 32; page++) {
    const response = object(
      await connection.call("thread/turns/list", {
        threadId: id,
        cursor,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
      }),
    );
    for (const turn of array(response["data"]).map(object)) {
      if (seen(turn)) return pending.reverse();
      if (turn["status"] !== "inProgress") pending.push(turn);
    }
    cursor = response["nextCursor"];
    if (cursor == null) return pending.reverse();
  }
  throw new CodexError("uncertain", "Unobserved management history exceeds the bounded page window");
}
