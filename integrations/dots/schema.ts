import { z } from "zod";

export const JobId = z
  .string()
  .regex(/^job_[a-f0-9]{64}$/)
  .brand<"JobId">();
export const Principal = z.string().min(1).max(128).brand<"Principal">();
export const RequestInput = z
  .object({
    origin_id: z.string().min(1).max(128),
    request_id: z.string().min(1).max(128),
    prompt: z.string().trim().min(1).max(8000),
  })
  .strict();
export const JobState = z.enum(["queued", "running", "decision_needed", "completed", "failed"]);
export const Outcome = z
  .object({
    job_id: JobId,
    revision: z.number().int().positive(),
    state: JobState,
    summary: z.string().max(16000),
    thread_id: z.string().max(128),
  })
  .strict();
export const EventName = z.enum(["dori.job.completed", "dori.job.decision_needed"]);
export const Filter = z.object({ job_id: JobId }).strict();
export const Delivery = z
  .object({
    mode: z.literal("webhook"),
    url: z.url().max(2048),
    secret: z.string().max(128),
  })
  .strict();
export const Subscribe = z
  .object({
    name: EventName,
    arguments: Filter,
    delivery: Delivery,
    cursor: z.null().optional(),
    ttlMs: z.number().int().min(1000).max(604800000).nullable().optional(),
  })
  .strict();
export const Unsubscribe = z
  .object({
    name: EventName,
    arguments: Filter,
    delivery: Delivery.omit({ secret: true }),
  })
  .strict();
export type JobId = z.infer<typeof JobId>;
export type Principal = z.infer<typeof Principal>;
export type RequestInput = z.infer<typeof RequestInput>;
export type Outcome = z.infer<typeof Outcome>;
export type Subscribe = z.infer<typeof Subscribe>;
export type Unsubscribe = z.infer<typeof Unsubscribe>;
export class BridgeError extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "BridgeError";
  }
}
