import { appendFileSync, readFileSync } from "node:fs";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) throw new TypeError("Expected object");
  return value;
};
export const leadTools = ["dori_job_status", "dori_report_outcome"].map((name) => ({
  name, description: "Test host outcome boundary", inputSchema: { type: "object", properties: {} },
}));
export const createPersonalTools = (value: unknown) => {
  const options = object(value);
  const binding = object(options["binding"]);
  const config = object(JSON.parse(readFileSync(String(options["configPath"]), "utf8")));
  const lookup = binding["admittedThreadForJob"];
  if (typeof lookup !== "function") throw new TypeError("Missing host lookup");
  return {
    async call(name: string, input: unknown) {
      const args = object(input);
      const admitted: unknown = await Reflect.apply(lookup, undefined, [args["job_id"]]);
      appendFileSync(String(config["receipt"]), `${JSON.stringify({ name, thread: binding["thread_id"], admitted, input })}\n`);
      return { durable: true };
    },
    close() {},
  };
};
