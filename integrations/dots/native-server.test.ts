import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { JobId } from "./schema.ts";

async function fixture(options: { readonly capabilityMode?: number; readonly instance?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dots-native-server-"));
  const configPath = join(directory, "config.json");
  const capabilityPath = join(directory, "native-task.json");
  await Bun.write(
    configPath,
    JSON.stringify({
      instance: "native-transport-test",
      directory: join(directory, "data"),
      principalFile: join(directory, "principals.json"),
      localPrincipal: "native-owner",
      runtimeHome: join(directory, "core"),
      runtimeCommand: ["/usr/bin/true"],
    }),
  );
  writeFileSync(
    capabilityPath,
    JSON.stringify({
      role: "dot",
      thread_id: "native-task-one",
      instance: options.instance ?? "native-transport-test",
      configPath,
    }),
    { mode: 0o600 },
  );
  chmodSync(capabilityPath, options.capabilityMode ?? 0o600);
  const client = new Client({ name: "dot-native-test", version: "1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "native-server.ts"), capabilityPath],
    env: { BUN_BE_BUN: "1" },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    rmSync(directory, { recursive: true });
    throw error;
  }
  return {
    client,
    async close() {
      await client.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test("native stdio submits to the fixed personal instance and returns its durable status", async () => {
  const f = await fixture();
  try {
    expect(f.client.getServerVersion()?.name).toBe("personal-codex-dori:native-task-one");
    const tools = await f.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["dori_job_status", "dori_submit_request"]);
    const submitted = await f.client.callTool({
      name: "dori_submit_request",
      arguments: { origin_id: "native-dot-task", request_id: "request-one", prompt: "Inspect status" },
    });
    const content = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(submitted.content);
    const body = content[0];
    if (!body) throw new TypeError("Submit returned no result");
    const job = z.object({ id: JobId }).parse(JSON.parse(body.text));
    const status = await f.client.callTool({ name: "dori_job_status", arguments: { job_id: job.id } });
    const statusContent = z.array(z.object({ type: z.literal("text"), text: z.string() })).parse(status.content);
    const statusBody = statusContent[0];
    if (!statusBody) throw new TypeError("Status returned no result");
    expect(JSON.parse(statusBody.text)).toMatchObject({
      id: job.id,
      state: "queued",
      admission: "admitted",
      origin_id: "native-dot-task",
    });
  } finally {
    await f.close();
  }
});

test.each([
  {
    name: "lead outcome",
    tool: "dori_report_outcome",
    input: { job_id: `job_${"a".repeat(64)}`, revision: 1, state: "completed", summary: "Forbidden" },
    reason: "tool_not_allowed",
  },
  {
    name: "configuration override",
    tool: "dori_submit_request",
    input: {
      origin_id: "native-dot-task",
      request_id: "override",
      prompt: "Do not change instance",
      configPath: "/another/private/config.json",
    },
    reason: "invalid_arguments",
  },
])("native stdio rejects $name", async ({ tool, input, reason }) => {
  const f = await fixture();
  try {
    expect(await f.client.callTool({ name: tool, arguments: input })).toMatchObject({
      isError: true,
      content: [{ type: "text", text: reason }],
    });
  } finally {
    await f.close();
  }
});

test.each([
  { name: "public capability file", options: { capabilityMode: 0o644 } },
  { name: "different personal instance", options: { instance: "another-instance" } },
])("native stdio refuses startup with $name", async ({ options }) => {
  let connected: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    await expect(
      (async () => {
        connected = await fixture(options);
      })(),
    ).rejects.toThrow();
  } finally {
    await connected?.close();
  }
});
