import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPTS = join(import.meta.dir, "..", "prompts");

/** DORI_PROMPTS_DIR overrides the repository prompts. */
export const promptsDir = (): string => process.env["DORI_PROMPTS_DIR"] || PROMPTS;

export const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(promptsDir(), name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);
