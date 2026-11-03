import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.argv[2]!, JSON.stringify({ parent: process.pid, helper: helper.pid }));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line); if (m.id) process.stdout.write(JSON.stringify({ id: m.id, result: { userAgent: "fixture" } }) + "\n");
});
