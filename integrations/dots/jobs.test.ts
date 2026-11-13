import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "./jobs.ts";
import { Principal } from "./schema.ts";
import { Store } from "./store.ts";

test("duplicate submission admits exactly one correlated envelope through stdin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dots-admission-"));
  const fixture = join(directory, "receiver.mjs");
  const log = join(directory, "received.jsonl");
  await Bun.write(
    fixture,
    `import {appendFileSync} from 'node:fs';
    const body=JSON.parse(await Bun.stdin.text());
    appendFileSync(${JSON.stringify(log)},JSON.stringify(body)+'\\n');`,
  );
  const store = new Store(":memory:", "personal");
  const jobs = new Jobs(
    store,
    [process.execPath, fixture],
    async () => {},
    ["/fixed/outcome", "update"],
    "/private/config",
  );
  const principal = Principal.parse("owner");
  const input = {
    origin_id: "dot-task",
    request_id: "request",
    prompt: "--to-shell $(touch /tmp/unwanted)",
  };
  try {
    const first = await jobs.submit(principal, input);
    const second = await jobs.submit(principal, input);
    const received = (await Bun.file(log).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      instance: "personal",
      job_id: first.id,
      origin_id: input.origin_id,
      request_id: input.request_id,
      prompt: input.prompt,
      outcome_protocol: {
        command: ["/fixed/outcome", "update"],
        next_revision: 1,
      },
    });
    expect(second).toMatchObject({
      id: first.id,
      admission: "admitted",
      state: "queued",
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("uncertain CLI admission is held durably and never retried", async () => {
  const store = new Store(":memory:", "personal");
  const jobs = new Jobs(store, ["/usr/bin/false"], async () => {}, ["/fixed/outcome"], "/private/config");
  const principal = Principal.parse("owner");
  const input = {
    origin_id: "dot",
    request_id: "request",
    prompt: "Read status",
  };
  try {
    const first = await jobs.submit(principal, input);
    const duplicate = await jobs.submit(principal, input);
    expect(first).toMatchObject({
      admission: "held",
      state: "decision_needed",
      revision: 1,
    });
    expect(duplicate).toMatchObject({
      id: first.id,
      admission: "held",
      revision: 1,
    });
  } finally {
    store.close();
  }
});

test("a failed event wake does not repeat the held admission transition", async () => {
  const store = new Store(":memory:", "personal");
  const principal = Principal.parse("owner");
  const input = { origin_id: "dot", request_id: "request", prompt: "Inspect" };
  const job = store.submit(principal, input);
  const jobs = new Jobs(
    store,
    ["/usr/bin/false"],
    async () => {
      throw new TypeError("wake unavailable");
    },
    ["/fixed/outcome"],
    "/private/config",
  );
  try {
    await expect(jobs.submit(principal, input)).rejects.toThrow("wake unavailable");
    expect(store.job(principal, job.id)).toMatchObject({ admission: "held", revision: 1 });
  } finally {
    store.close();
  }
});

test("restart converts an interrupted admission into a decision instead of resending", async () => {
  const store = new Store(":memory:", "personal");
  const principal = Principal.parse("owner");
  const job = store.submit(principal, {
    origin_id: "dot",
    request_id: "request",
    prompt: "Inspect",
  });
  store.db.run("UPDATE jobs SET admission='submitting' WHERE id=?", [job.id]);
  const jobs = new Jobs(store, ["/usr/bin/false"], async () => {}, ["/fixed/outcome"], "/private/config");
  try {
    await jobs.recover();
    expect(store.job(principal, job.id)).toMatchObject({
      admission: "held",
      state: "decision_needed",
      revision: 1,
    });
  } finally {
    store.close();
  }
});
