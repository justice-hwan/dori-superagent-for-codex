import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/store.ts";
import { loopTick } from "../../src/loop.ts";
import type { Deps } from "../../src/harness.ts";
const root = process.argv[2]!, marker = join(root, "critical");
const d: Deps = {
  store: new Store(root), now: Date.now, doriCmd: "fixture", host: () => ({ load1: 0, cores: 8, memFreePct: 50 }),
  exec: async () => ({ code: 1, stdout: "", stderr: "fixture" }),
  sessions: {
    known: id => id === "lead-thread" || id.startsWith("thread-"),
    create: async () => {
      writeFileSync(marker, String(process.pid), { flag: "wx" });
      try { appendFileSync(join(root, "starts"), String(process.pid) + "\n"); await Bun.sleep(100); return `thread-${process.pid}`; }
      finally { unlinkSync(marker); }
    },
    status: async () => "idle", deliver: async () => {}, read: async () => "", close: async () => {}, review: async () => "",
  },
};
writeFileSync(join(root, `ready-${process.pid}`), "ready");
while (!existsSync(join(root, "go"))) await Bun.sleep(2);
console.log(JSON.stringify(await loopTick(d, { maxStarts: 1 })));
