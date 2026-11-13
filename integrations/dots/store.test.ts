import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Principal } from "./schema.ts";
import { Store } from "./store.ts";

const alice = Principal.parse("alice");
const bob = Principal.parse("bob");
const input = {
  origin_id: "dot-task-1",
  request_id: "request-1",
  prompt: "Read the project status",
};

describe("durable instance-scoped requests", () => {
  test("conflicting, skipped, and post-terminal revisions cannot change the recorded outcome", () => {
    const store = new Store(":memory:", "instance-a");
    try {
      const job = store.submit(alice, input);
      const outcome = {
        job_id: job.id,
        revision: 1,
        state: "completed" as const,
        summary: "Done",
        thread_id: "thread",
      };
      store.update(outcome);
      expect(() => store.update({ ...outcome, summary: "Different" })).toThrow("revision_conflict");
      expect(() => store.update({ ...outcome, revision: 3 })).toThrow("revision_conflict");
      expect(() => store.update({ ...outcome, revision: 2, state: "running" })).toThrow("terminal_job");
      expect(store.job(alice, job.id)).toMatchObject({ state: "completed", summary: "Done", revision: 1 });
    } finally {
      store.close();
    }
  });
  test("repeated writes retain one job and reject a changed payload", () => {
    const store = new Store(":memory:", "instance-a");
    try {
      const first = store.submit(alice, input);
      const repeated = store.submit(alice, input);
      expect(repeated.id).toBe(first.id);
      expect(() => store.submit(alice, { ...input, prompt: "Change the project" })).toThrow("request_id_conflict");
      expect(store.db.query("SELECT count(*) AS total FROM jobs").get()).toEqual({ total: 1 });
    } finally {
      store.close();
    }
  });
  test("job status cannot cross authenticated principals", () => {
    const store = new Store(":memory:", "instance-a");
    try {
      const job = store.submit(alice, input);
      expect(() => store.job(bob, job.id)).toThrow("job_not_found");
      expect(store.submit(bob, input).id).not.toBe(job.id);
    } finally {
      store.close();
    }
  });
  test("outcomes and pending signed deliveries survive restart without duplicate revisions", () => {
    const directory = mkdtempSync(join(tmpdir(), "dots-store-"));
    const path = join(directory, "jobs.sqlite");
    let store = new Store(path, "instance-a");
    try {
      const job = store.submit(alice, input);
      store.db.run("INSERT INTO subscriptions(id,principal,name,job_id,url,secret,expires) VALUES(?,?,?,?,?,?,?)", [
        "sub-1",
        alice,
        "dori.job.completed",
        job.id,
        "https://callback.example/events",
        "secret",
        Date.now() + 60000,
      ]);
      const outcome = {
        job_id: job.id,
        revision: 1,
        state: "completed" as const,
        summary: "Done",
        thread_id: "thread-1",
      };
      store.update(outcome);
      store.update(outcome);
      store.update({ ...outcome, revision: 0, state: "running" });
      store.close();
      store = new Store(path, "instance-a");
      expect(store.job(alice, job.id).state).toBe("completed");
      const pending = store.pending(Date.now());
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0]?.body ?? "{}")).toMatchObject({
        name: "dori.job.completed",
        data: {
          job_id: job.id,
          origin_id: input.origin_id,
          request_id: input.request_id,
          summary: "Done",
        },
      });
      expect(() => new Store(path, "another-instance")).toThrow("instance_mismatch");
    } finally {
      store.close();
      rmSync(directory, { recursive: true });
    }
  });
  test("only matching nonexpired subscriptions receive a decision event", () => {
    const store = new Store(":memory:", "instance-a");
    try {
      const job = store.submit(alice, input);
      for (const [id, name, expires] of [
        ["active", "dori.job.decision_needed", Date.now() + 60000],
        ["wrong-event", "dori.job.completed", Date.now() + 60000],
        ["expired", "dori.job.decision_needed", 1],
      ] as const) {
        store.db.run("INSERT INTO subscriptions(id,principal,name,job_id,url,secret,expires) VALUES(?,?,?,?,?,?,?)", [
          id,
          alice,
          name,
          job.id,
          "https://callback.example/events",
          "secret",
          expires,
        ]);
      }
      store.update({
        job_id: job.id,
        revision: 1,
        state: "decision_needed",
        summary: "Choose a branch",
        thread_id: "thread",
      });
      expect(store.pending(Date.now()).map((row) => row.subscription_id)).toEqual(["active"]);
    } finally {
      store.close();
    }
  });
});
