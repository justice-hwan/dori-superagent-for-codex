import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BridgeError, JobId, type Outcome, type Principal, type RequestInput } from "./schema.ts";

const Job = z.object({
  id: JobId,
  principal: z.string(),
  origin_id: z.string(),
  request_id: z.string(),
  prompt: z.string(),
  state: z.string(),
  summary: z.string(),
  thread_id: z.string(),
  revision: z.number(),
  admission: z.string(),
});
export const Subscription = z.object({
  id: z.string(),
  principal: z.string(),
  name: z.string(),
  job_id: JobId,
  url: z.string(),
  secret: z.string(),
  old_secret: z.string(),
  rotate_until: z.number(),
  expires: z.number(),
});
export type Subscription = z.infer<typeof Subscription>;
export const Pending = z.object({
  event_id: z.string(),
  subscription_id: z.string(),
  body: z.string(),
  attempts: z.number(),
  next_at: z.number(),
});
export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** One private database belongs to exactly one configured Dori instance. */
export class Store {
  readonly db: Database;
  constructor(
    path: string,
    readonly instance: string,
  ) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, origin_id TEXT NOT NULL,
        request_id TEXT NOT NULL, prompt TEXT NOT NULL, state TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
        admission TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, name TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id), url TEXT NOT NULL, secret TEXT NOT NULL,
        old_secret TEXT NOT NULL DEFAULT '', rotate_until INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT NOT NULL, subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
        body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(event_id, subscription_id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        event_id TEXT NOT NULL, subscription_id TEXT NOT NULL, status INTEGER NOT NULL,
        attempts INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(event_id, subscription_id)
      );
      CREATE TABLE IF NOT EXISTS verifications (
        principal TEXT NOT NULL, url TEXT NOT NULL, secret_hash TEXT NOT NULL, until_at INTEGER NOT NULL,
        PRIMARY KEY(principal,url)
      );
    `);
    this.db.run("INSERT OR IGNORE INTO metadata VALUES (1,?)", [instance]);
    const metadata = z.object({ instance: z.string() }).parse(this.db.query("SELECT instance FROM metadata").get());
    if (metadata.instance !== instance) {
      this.db.close();
      throw new BridgeError(-32001, "instance_mismatch");
    }
  }
  close(): void {
    this.db.close();
  }
  submit(principal: Principal, input: RequestInput) {
    const id = JobId.parse(
      `job_${digest(JSON.stringify([this.instance, principal, input.origin_id, input.request_id]))}`,
    );
    this.db.run(
      "INSERT OR IGNORE INTO jobs(id,principal,origin_id,request_id,prompt,state) VALUES(?,?,?,?,?,'queued')",
      [id, principal, input.origin_id, input.request_id, input.prompt],
    );
    const job = this.job(principal, id);
    if (job.prompt !== input.prompt) throw new BridgeError(-32009, "request_id_conflict");
    return job;
  }
  job(principal: Principal, id: JobId) {
    const row = this.db.query("SELECT * FROM jobs WHERE id=? AND principal=?").get(id, principal);
    if (!row) throw new BridgeError(-32004, "job_not_found");
    return Job.parse(row);
  }
  update(input: Outcome): void {
    this.db.transaction(() => {
      const previous = Job.parse(this.db.query("SELECT * FROM jobs WHERE id=?").get(input.job_id));
      if (input.revision < previous.revision) return;
      if (input.revision === previous.revision) {
        if (
          input.state !== previous.state ||
          input.summary !== previous.summary ||
          input.thread_id !== previous.thread_id
        ) {
          throw new BridgeError(-32009, "revision_conflict");
        }
        return;
      }
      if (input.revision !== previous.revision + 1) throw new BridgeError(-32009, "revision_conflict");
      if (previous.state === "completed" || previous.state === "failed") throw new BridgeError(-32009, "terminal_job");
      this.db.run("UPDATE jobs SET state=?,summary=?,thread_id=?,revision=? WHERE id=?", [
        input.state,
        input.summary,
        input.thread_id,
        input.revision,
        input.job_id,
      ]);
      const name =
        input.state === "decision_needed"
          ? "dori.job.decision_needed"
          : input.state === "completed" || input.state === "failed"
            ? "dori.job.completed"
            : undefined;
      if (!name) return;
      const eventId = `evt_${digest(JSON.stringify([this.instance, input.job_id, input.revision]))}`;
      const body = JSON.stringify({
        eventId,
        name,
        timestamp: new Date().toISOString(),
        cursor: null,
        data: {
          ...input,
          origin_id: previous.origin_id,
          request_id: previous.request_id,
        },
      });
      this.db.run(
        `INSERT OR IGNORE INTO outbox(event_id,subscription_id,body)
        SELECT ?,id,? FROM subscriptions WHERE job_id=? AND name=? AND expires>?`,
        [eventId, body, input.job_id, name, Date.now()],
      );
    })();
  }
  subscription(id: string): Subscription | undefined {
    const row = this.db.query("SELECT * FROM subscriptions WHERE id=?").get(id);
    return row ? Subscription.parse(row) : undefined;
  }
  pending(now: number) {
    return z.array(Pending).parse(this.db.query("SELECT * FROM outbox WHERE next_at<=? LIMIT 100").all(now));
  }
}
