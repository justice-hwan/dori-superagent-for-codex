import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { JobId } from "./schema.ts";

test("native CLI submits one job, persists the lead outcome, and reads it after each process exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dots-cli-"));
  const config = join(directory, "config.json");
  const receiver = join(directory, "receiver.mjs");
  const received = join(directory, "received.jsonl");
  await Bun.write(
    receiver,
    `import {appendFileSync} from "node:fs";
    appendFileSync(${JSON.stringify(received)}, (await Bun.stdin.text())+"\\n");`,
  );
  await Bun.write(
    config,
    JSON.stringify({
      instance: "personal-cli-test",
      directory: join(directory, "data"),
      principalFile: join(directory, "principals.json"),
      localPrincipal: "owner",
      runtimeCommand: [process.execPath, receiver],
    }),
  );
  async function cli(command: string, input: unknown) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), command], {
      env: { ...process.env, DORI_DOTS_CONFIG: config },
      stdin: new Response(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new TypeError(`CLI failed: ${error}`);
    return JSON.parse(output);
  }
  const input = { origin_id: "dot-task", request_id: "request", prompt: "Inspect project status" };
  try {
    const submitted = z.object({ id: JobId }).parse(await cli("submit", input));
    await cli("update", {
      job_id: submitted.id,
      revision: 1,
      state: "completed",
      summary: "Inspected",
      thread_id: "lead-thread",
    });
    expect(await cli("status", { job_id: submitted.id })).toMatchObject({
      id: submitted.id,
      state: "completed",
      summary: "Inspected",
      thread_id: "lead-thread",
      revision: 1,
    });
    expect(await cli("submit", input)).toMatchObject({ id: submitted.id, state: "completed" });
    expect((await Bun.file(received).text()).trim().split("\n")).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
