import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2]!, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line); if (m.id) process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "fixture" } }) + "\n");
});
