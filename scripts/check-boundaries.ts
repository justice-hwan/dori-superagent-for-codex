import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..");
const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)]);
const files = ["src", "prompts", "skills"].flatMap((d) => walk(join(root, d))).concat([join(root, "install.sh"), join(root, "package.json")]);
const forbidden = [/omo\.dev/i, /\bomo\b/i, /\bherdr\b/i, /DORI_TELEMETRY/, /x-omo-ingest-key/, /\/v1\/register/];
const failures = files.filter((f) => forbidden.some((p) => p.test(readFileSync(f, "utf8"))));
if (failures.length) throw new Error(`Legacy runtime or collector references: ${failures.join(", ")}`);
console.log(`BOUNDARIES_OK files=${files.length}`);
