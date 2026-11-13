import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const load = createRequire(import.meta.url);
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) throw new TypeError("Expected object");
  return value;
};
export const leadTools = ["dori_job_status", "dori_report_outcome"].map((name) => ({
  name, description: "Runtime loader boundary fixture", inputSchema: { type: "object", properties: {} },
}));
export const createPersonalTools = async (value: unknown) => {
  const config = object(JSON.parse(readFileSync(String(object(value)["configPath"]), "utf8")));
  await Promise.resolve();
  if (config["phase"] === "factory") load(String(config["payload"]));
  return {
    async call() {
      await Promise.resolve();
      if (config["phase"] === "call") load(String(config["payload"]));
      if (config["phase"] === "result") return {
        get value() {
          load(String(config["payload"]));
          return "unreachable";
        },
      };
      return { durable: true };
    },
    close() {
      if (config["phase"] === "close") load(String(config["payload"]));
    },
  };
};
