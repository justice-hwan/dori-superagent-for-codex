import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createPersonalTools } from "./host-tools.ts";
import { JobId, Principal } from "./schema.ts";
import { Store } from "./store.ts";

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dots-host-"));
  const configPath = join(directory, "config.json");
  const data = join(directory, "data");
  await Bun.write(
    configPath,
    JSON.stringify({
      instance: "personal-host-test",
      directory: data,
      principalFile: join(directory, "principals.json"),
      localPrincipal: "owner",
      runtimeHome: join(directory, "core"),
      runtimeCommand: ["/usr/bin/true"],
    }),
  );
  const dot = await createPersonalTools({ configPath, binding: { role: "dot" } });
  const job = z
    .object({ id: JobId })
    .parse(
      await dot.call("dori_submit_request", { origin_id: "dot-task", request_id: "one", prompt: "Inspect status" }),
    );
  const admissions = new Map<JobId, string>([[job.id, "trusted-lead-thread"]]);
  const lead = await createPersonalTools({
    configPath,
    binding: {
      role: "lead",
      thread_id: "trusted-lead-thread",
      admittedThreadForJob: async (id) => admissions.get(id),
    },
  });
  return {
    directory,
    configPath,
    database: join(data, "dots.sqlite"),
    dot,
    lead,
    admissions,
    id: job.id,
    close() {
      lead.close();
      dot.close();
      rmSync(directory, { recursive: true });
    },
  };
}

test("trusted tools persist the bound lead result for the Dot-created task after reopening", async () => {
  const f = await fixture();
  try {
    await f.lead.call("dori_report_outcome", {
      job_id: f.id,
      revision: 1,
      state: "completed",
      summary: "Inspected status",
    });
    const reopened = await createPersonalTools({ configPath: f.configPath, binding: { role: "dot" } });
    try {
      expect(await reopened.call("dori_job_status", { job_id: f.id })).toMatchObject({
        id: f.id,
        state: "completed",
        thread_id: "trusted-lead-thread",
        summary: "Inspected status",
        admission: "admitted",
        revision: 1,
      });
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test.each([
  ["dot", "dori_report_outcome"],
  ["lead", "dori_submit_request"],
] as const)("%s role cannot execute %s", async (role, name) => {
  const f = await fixture();
  try {
    const input =
      name === "dori_submit_request"
        ? { origin_id: "other", request_id: "denied", prompt: "Unauthorized request" }
        : { job_id: f.id, revision: 1, state: "completed", summary: "Unauthorized result" };
    await expect(f[role].call(name, input)).rejects.toMatchObject({ reason: "tool_not_allowed" });
  } finally {
    f.close();
  }
});

test.each(["dori_job_status", "dori_report_outcome"])("lead %s rejects a job outside trusted binding", async (name) => {
  const f = await fixture();
  try {
    const other = z
      .object({ id: JobId })
      .parse(
        await f.dot.call("dori_submit_request", { origin_id: "dot-task", request_id: "two", prompt: "Another task" }),
      );
    const args =
      name === "dori_job_status"
        ? { job_id: other.id }
        : { job_id: other.id, revision: 1, state: "completed", summary: "Wrong job" };
    await expect(f.lead.call(name, args)).rejects.toMatchObject({ reason: "job_not_admitted" });
  } finally {
    f.close();
  }
});

test.each(["dori_job_status", "dori_report_outcome"])(
  "lead %s rejects conflicting durable thread ownership",
  async (name) => {
    const f = await fixture();
    const store = new Store(f.database, "personal-host-test");
    try {
      store.update({ job_id: f.id, revision: 1, state: "running", summary: "", thread_id: "different-thread" });
      const args =
        name === "dori_job_status"
          ? { job_id: f.id }
          : { job_id: f.id, revision: 2, state: "completed", summary: "Wrong thread" };
      await expect(f.lead.call(name, args)).rejects.toMatchObject({ reason: "thread_binding_conflict" });
      expect(store.job(Principal.parse("owner"), f.id).revision).toBe(1);
    } finally {
      store.close();
      f.close();
    }
  },
);

test.each(["revoked", "cross-thread"] as const)("lead rejects %s admission on the next call", async (change) => {
  const f = await fixture();
  try {
    await f.lead.call("dori_job_status", { job_id: f.id });
    switch (change) {
      case "revoked":
        f.admissions.delete(f.id);
        break;
      case "cross-thread":
        f.admissions.set(f.id, "replacement-thread");
        break;
    }
    await expect(
      f.lead.call("dori_report_outcome", { job_id: f.id, revision: 1, state: "completed", summary: "Stale caller" }),
    ).rejects.toMatchObject({
      reason: change === "revoked" ? "job_not_admitted" : "thread_binding_conflict",
    });
  } finally {
    f.close();
  }
});

test("long-lived lead reports a later job only after trusted admission", async () => {
  const f = await fixture();
  try {
    const later = z.object({ id: JobId }).parse(
      await f.dot.call("dori_submit_request", {
        origin_id: "dot-task",
        request_id: "later",
        prompt: "Later request",
      }),
    );
    f.admissions.set(later.id, "trusted-lead-thread");
    await f.lead.call("dori_report_outcome", {
      job_id: later.id,
      revision: 1,
      state: "completed",
      summary: "Later result",
    });
    expect(await f.dot.call("dori_job_status", { job_id: later.id })).toMatchObject({
      state: "completed",
      summary: "Later result",
      thread_id: "trusted-lead-thread",
    });
  } finally {
    f.close();
  }
});

test("outcome tool rejects a model-supplied thread rather than overwriting trusted binding", async () => {
  const f = await fixture();
  try {
    await expect(
      f.lead.call("dori_report_outcome", {
        job_id: f.id,
        revision: 1,
        state: "completed",
        summary: "Forged thread",
        thread_id: "model-selected-thread",
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(await f.dot.call("dori_job_status", { job_id: f.id })).toMatchObject({ revision: 0, thread_id: "" });
  } finally {
    f.close();
  }
});

test.each(["runtimeHome", "runtimeCommand", "configPath", "principal", "instance"])(
  "request tool rejects model-selected %s",
  async (field) => {
    const f = await fixture();
    try {
      await expect(
        f.dot.call("dori_submit_request", {
          origin_id: "dot-task",
          request_id: "forged",
          prompt: "Do not change routing",
          [field]: "/model-selected",
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
    } finally {
      f.close();
    }
  },
);
