import { chmodSync, mkdirSync } from "node:fs";
import { type Tool, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { Jobs } from "./jobs.ts";
import { BridgeError, Filter, type JobId, Outcome, Principal, RequestInput } from "./schema.ts";
import { Store } from "./store.ts";
import { wakeBridge } from "./wake.ts";

type AdmissionLookup = (id: JobId) => Promise<string | undefined>;
const Binding = z.discriminatedUnion("role", [
  z.object({ role: z.literal("dot") }).strict(),
  z
    .object({
      role: z.literal("lead"),
      thread_id: z.string().min(1).max(128),
      admittedThreadForJob: z.custom<AdmissionLookup>((value) => typeof value === "function"),
    })
    .strict(),
]);
const Options = z.object({ configPath: z.string().startsWith("/"), binding: Binding }).strict();
const ReportOutcome = Outcome.omit({ thread_id: true }).extend({
  state: z.enum(["running", "decision_needed", "completed", "failed"]),
});

export const requestTools = [
  ToolSchema.parse({
    name: "dori_submit_request",
    description: "Submit a bounded request to the configured personal lead. Reuse origin_id/request_id for retries.",
    inputSchema: z.toJSONSchema(RequestInput),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }),
  ToolSchema.parse({
    name: "dori_job_status",
    description: "Read a durable job result and lead admission state.",
    inputSchema: z.toJSONSchema(Filter),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }),
] as const;

/** Only the trusted host supplies startup binding; model tool arguments never supply this object. */
export async function createPersonalTools(options: z.infer<typeof Options>) {
  const { configPath, binding } = Options.parse(options);
  const config = await loadConfig(configPath);
  const principal = Principal.parse(config.localPrincipal);
  process.umask(0o077);
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  chmodSync(config.directory, 0o700);
  const store = new Store(config.database, config.instance);
  const wake = () => (config.oauth ? wakeBridge(config.socket) : Promise.resolve());
  const jobs = new Jobs(store, config.runtimeCommand, wake, config.outcomeCommand, config.configPath);
  const tools: Tool[] = [];
  switch (binding.role) {
    case "dot":
      tools.push(...requestTools);
      break;
    case "lead":
      tools.push(
        requestTools[1],
        ToolSchema.parse({
          name: "dori_report_outcome",
          description: "Persist an outcome for a job assigned to this lead thread by the trusted host.",
          inputSchema: z.toJSONSchema(ReportOutcome),
          annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        }),
      );
      break;
    default:
      throw new TypeError(`Unsupported binding: ${binding satisfies never}`);
  }

  async function authorizeJob(id: JobId) {
    switch (binding.role) {
      case "dot":
        return;
      case "lead": {
        const thread = await binding.admittedThreadForJob(id);
        if (!thread) throw new BridgeError(-32001, "job_not_admitted");
        if (thread !== binding.thread_id) throw new BridgeError(-32001, "thread_binding_conflict");
        return;
      }
      default:
        throw new TypeError(`Unsupported binding: ${binding satisfies never}`);
    }
  }
  function readJob(id: JobId) {
    const job = store.job(principal, id);
    if (binding.role === "lead" && job.thread_id && job.thread_id !== binding.thread_id)
      throw new BridgeError(-32001, "thread_binding_conflict");
    return job;
  }

  return {
    tools,
    async call(name: string, input: unknown) {
      if (!tools.some((tool) => tool.name === name)) throw new BridgeError(-32001, "tool_not_allowed");
      switch (name) {
        case "dori_submit_request":
          return jobs.submit(principal, RequestInput.parse(input));
        case "dori_job_status": {
          const { job_id } = Filter.parse(input);
          await authorizeJob(job_id);
          return readJob(job_id);
        }
        case "dori_report_outcome": {
          if (binding.role !== "lead") throw new BridgeError(-32001, "tool_not_allowed");
          const outcome = ReportOutcome.parse(input);
          await authorizeJob(outcome.job_id);
          store.db.transaction(() => {
            readJob(outcome.job_id);
            store.update({ ...outcome, thread_id: binding.thread_id });
          })();
          await wake();
          return { job_id: outcome.job_id, revision: outcome.revision, durable: true };
        }
        default:
          throw new BridgeError(-32602, "unknown_tool");
      }
    },
    close: () => store.close(),
  };
}
