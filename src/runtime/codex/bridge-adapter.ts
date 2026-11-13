import { pathToFileURL } from "node:url";
import { Refusal } from "../../refusal.ts";
import { trustedPath } from "./bridge-install.ts";
import { adapterConfig, admittedThreadForJob } from "./bridge-jobs.ts";
import type { BridgeScope } from "./bridge-tools.ts";
import { array, object, text } from "./protocol.ts";
import { argumentsOf } from "./bridge-schema.ts";

const allowed = ["dori_job_status", "dori_report_outcome"];
type Adapter = {
  readonly descriptors: readonly Record<string, unknown>[];
  readonly factory: (options: unknown) => unknown;
  readonly configPath: string;
};
async function load(scope: BridgeScope): Promise<Adapter | undefined> {
  const config = adapterConfig(scope.root);
  if (!config || scope.role !== "lead") return undefined;
  const module = trustedPath(config.module, scope.cwd);
  const configPath = trustedPath(config.configPath, scope.cwd);
  const imported: unknown = await import(pathToFileURL(module).href);
  const exports = object(imported);
  const factory = exports["createPersonalTools"];
  if (typeof factory !== "function") throw new Refusal("Adapter omitted createPersonalTools");
  const descriptors = array(exports["leadTools"]).map(object);
  const names = descriptors.map((tool) => text(tool["name"]));
  if (
    names.length !== allowed.length ||
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.includes(name))
  )
    throw new Refusal("Adapter exposes an unsupported management tool");
  return {
    descriptors,
    factory: (options: unknown): unknown => Reflect.apply(factory, undefined, [options]),
    configPath,
  };
}
export const adapterDescriptors = async (scope: BridgeScope): Promise<readonly Record<string, unknown>[]> =>
  (await load(scope))?.descriptors ?? [];

/** The fixed trusted adapter receives host-derived identity, never model-supplied thread/paths. */
export const callAdapter = async (scope: BridgeScope, name: string, input: unknown): Promise<unknown> => {
  if (!allowed.includes(name)) throw new Refusal("Unknown adapter tool");
  const adapter = await load(scope);
  if (!adapter) throw new Refusal("No lead outcome adapter configured");
  const args = argumentsOf(input, name === "dori_job_status" ? ["job_id"] : ["job_id", "revision", "state", "summary"]);
  const job = text(args["job_id"]);
  if (admittedThreadForJob(scope.root, job) !== scope.id)
    throw new Refusal("Job was not delivered to this lead thread");
  const value: unknown = await adapter.factory({
    configPath: adapter.configPath,
    binding: {
      role: "lead",
      thread_id: scope.id,
      admittedThreadForJob: async (id: string) => admittedThreadForJob(scope.root, id),
    },
  });
  const service = object(value);
  const call = service["call"];
  const close = service["close"];
  if (typeof call !== "function" || typeof close !== "function") throw new Refusal("Invalid lead outcome adapter");
  try {
    return await call(name, input);
  } finally {
    close();
  }
};
