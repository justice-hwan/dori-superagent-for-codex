import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "../../refusal.ts";
import type { SessionRef } from "../types.ts";
import type { Store } from "../../store.ts";
import { object, text } from "./protocol.ts";

export const adapterConfig = (root: string) => {
  const path = join(root, "config.json");
  if (!existsSync(path)) return undefined;
  const config = object(JSON.parse(readFileSync(path, "utf8")));
  if (config["codexBridgeAdapter"] === undefined) return undefined;
  const adapter = object(config["codexBridgeAdapter"]);
  return {
    module: text(adapter["module"]),
    configPath: text(adapter["configPath"]),
    instance: text(adapter["instance"]),
  };
};

function request(store: Store, ref: SessionRef, input: string) {
  if (ref.runtime !== "codex" || store.roles().lead?.id !== ref.id || Buffer.byteLength(input) > 32768)
    return undefined;
  const config = adapterConfig(store.root);
  if (!config) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const data = object(value);
  if (data["kind"] !== "dots_development_request" || data["instance"] !== config.instance) return undefined;
  const job = text(data["job_id"]);
  if (!/^job_[a-f0-9]{64}$/.test(job)) throw new Refusal("Invalid Dots job id");
  const origin = text(data["origin_id"]);
  const correlation = text(data["request_id"]);
  const prompt = text(data["prompt"]);
  if (
    !origin ||
    origin.length > 128 ||
    !correlation ||
    correlation.length > 128 ||
    !prompt.trim() ||
    prompt.length > 8000
  )
    throw new Refusal("Invalid Dots request envelope");
  const fingerprint = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([config.instance, origin, correlation, prompt]))
    .digest("hex");
  return { job, instance: config.instance, thread: ref.id, fingerprint, admitted: false };
}

/** Reserve correlation before external submission; outcomes require confirmed delivery. */
export const reserveJob = (store: Store, ref: SessionRef, input: string): void => {
  const binding = request(store, ref, input);
  if (!binding) return;
  const directory = join(store.root, "codex", "jobs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${binding.job}.json`);
  try {
    writeFileSync(path, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const previous = object(JSON.parse(readFileSync(path, "utf8")));
    if (
      previous["thread"] !== binding.thread ||
      previous["fingerprint"] !== binding.fingerprint ||
      previous["instance"] !== binding.instance
    )
      throw new Refusal("Dots request correlation is already bound to different work");
  }
};
export const confirmJob = (store: Store, ref: SessionRef, input: string): void => {
  const binding = request(store, ref, input);
  if (!binding) return;
  reserveJob(store, ref, input);
  const path = join(store.root, "codex", "jobs", `${binding.job}.json`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...binding, admitted: true }), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
};
export const admittedThreadForJob = (root: string, job: string): string | undefined => {
  if (!/^job_[a-f0-9]{64}$/.test(job)) throw new Refusal("Invalid Dots job id");
  const config = adapterConfig(root);
  const path = join(root, "codex", "jobs", `${job}.json`);
  if (!config || !existsSync(path)) return undefined;
  const data = object(JSON.parse(readFileSync(path, "utf8")));
  return data["instance"] === config.instance && data["admitted"] === true ? text(data["thread"]) : undefined;
};
