import type { AgentStatus, CreateSpec, Probe } from "../types.ts";
import { fileURLToPath } from "node:url";
import { array, type CodexConnection, CodexError, object, text } from "./protocol.ts";

export type Environment = Readonly<Record<string, string | undefined>>;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export const defaultCommand = `${quote(process.execPath)} ${quote(fileURLToPath(new URL("../../cli.ts", import.meta.url)))}`;
const toolEnvironment = (root: string, spec: CreateSpec, env: Environment) => ({
  ...spec.env,
  DORI_HOME: root,
  DORI_RUNTIME: "codex",
  DORI_LANE: spec.env["DORI_LANE"] || "",
  DORI_CMD: spec.env["DORI_CMD"] || env["DORI_CMD"] || defaultCommand,
});
export const instructions = (root: string, spec: CreateSpec, env: Environment): string => {
  const scope = toolEnvironment(root, spec, env);
  const scoped = Object.entries(scope)
    .filter(([key]) => key === "DORI_HOME" || key === "DORI_RUNTIME" || key === "DORI_LANE")
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(" ");
  const management =
    env["DORI_CODEX_BRIDGE"] === "stdio"
      ? `
Use the dori MCP management tools for all harness operations. Do not run the CLI in sandboxed shell tools.
For lead: dori_start takes key and brief CONTENT, with this session's fixed workspace; dori_send and dori_done take a lane key.
For lane: dori_report and dori_ready apply only to your own lane; omit its key. dori_ready needs evidence.
These typed tools replace CLI operations mentioned in role instructions or briefs. Ordinary task tools remain sandboxed.
If dori_done refuses because the lane is still working, wait for its turn to finish, then use dori_status before closing.`
      : "";
  return `This is a Dori ${spec.role} session. Tool environment: ${JSON.stringify(scope)}.
Scoped CLI command prefix: ${scoped} ${scope.DORI_CMD}
Run Dori CLI commands with these environment values. Use argv arrays, keep each argument separate,
and pass user text as an argument rather than interpolating it into shell source.${management}`;
};

export const startParams = (root: string, spec: CreateSpec, env: Environment): Record<string, unknown> => ({
  cwd: spec.cwd,
  model: env["DORI_CODEX_MODEL"] || "gpt-6.1-sol",
  approvalPolicy: env["DORI_CODEX_APPROVAL_POLICY"] || "on-request",
  sandbox: env["DORI_CODEX_SANDBOX"] || "workspace-write",
  developerInstructions: instructions(root, spec, env),
  config: { shell_environment_policy: { inherit: "all", set: toolEnvironment(root, spec, env) } },
});

export const threadStatus = (value: unknown): AgentStatus => {
  const status = object(value);
  switch (status["type"]) {
    case "idle":
      return "idle";
    case "active":
      return array(status["activeFlags"]).some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput")
        ? "blocked"
        : "working";
    case "systemError":
      return "error";
    case "notLoaded":
      return "gone";
    default:
      throw new CodexError("protocol", "Unknown Codex thread status");
  }
};

export const probeThread = async (connection: CodexConnection, id: string): Promise<Probe> => {
  let thread: Record<string, unknown>;
  try {
    const response = object(await connection.call("thread/read", { threadId: id, includeTurns: false }));
    thread = object(response["thread"]);
    if (object(thread["status"])["type"] === "notLoaded") {
      const resumed = object(await connection.call("thread/resume", { threadId: id, excludeTurns: true }));
      thread = object(resumed["thread"]);
    }
  } catch (error) {
    if (
      error instanceof CodexError &&
      error.kind === "remote" &&
      /thread.*(?:not found|does not exist)|no thread.*found/i.test(error.message)
    )
      return { status: "gone", shellInFront: false };
    throw error;
  }
  return {
    status: threadStatus(thread["status"]),
    agent: "codex",
    shellInFront: false,
    ...(typeof thread["cwd"] === "string" ? { cwd: thread["cwd"] } : {}),
  };
};

/** Page durable items, not streaming deltas, so a fresh client sees completed output. */
export const readThread = async (
  connection: CodexConnection,
  id: string,
  lines: number,
  assistantOnly = false,
): Promise<string> => {
  if (lines <= 0) return "";
  if ((await probeThread(connection, id)).status === "gone") throw new CodexError("remote", "Codex thread is gone");
  const messages: string[] = [];
  let cursor: string | undefined;
  do {
    const response = object(
      await connection.call("thread/items/list", {
        threadId: id,
        sortDirection: "asc",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of array(response["data"])) {
      const item = object(object(value)["item"]);
      switch (item["type"]) {
        case "agentMessage":
          messages.push(`${assistantOnly ? "" : "assistant: "}${text(item["text"])}`);
          break;
        case "userMessage":
          if (assistantOnly) break;
          messages.push(
            `user: ${array(item["content"])
              .map((part) => {
                const content = object(part);
                return content["type"] === "text" ? text(content["text"]) : "";
              })
              .filter(Boolean)
              .join("\n")}`,
          );
          break;
      }
    }
    cursor =
      response["nextCursor"] === null || response["nextCursor"] === undefined
        ? undefined
        : text(response["nextCursor"]);
  } while (cursor);
  return messages.join("\n").split("\n").slice(-lines).join("\n");
};
