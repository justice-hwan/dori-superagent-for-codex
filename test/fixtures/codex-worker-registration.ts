import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinHostRuntime } from "../../src/runtime/codex/bridge-install.ts";
import { CodexStore } from "../../src/runtime/codex/store.ts";
import { startWorker } from "../../src/runtime/codex/workers.ts";

const root = process.env["DORI_HOME"];
const id = process.argv[2];
if (!root || !id) throw new Error("Registration fixture needs its private home and worker ID");
const store = new CodexStore(root);
const entry = await store.owned({ runtime: "codex", id });
const save = store.save.bind(store);
store.save = async (next) => {
  if (next.id === id && next.pid && next.birth) {
    const observed = { id, pid: next.pid, birth: next.birth };
    writeFileSync(join(store.directory, `${id}.registration-fixture`), JSON.stringify(observed));
    process.stdout.write(`${JSON.stringify(observed)}\n`);
    await new Promise<void>(() => {});
  } else await save(next);
};
const host = pinHostRuntime(entry.spec.cwd, process.env);
await startWorker(store, entry, `${host.command} loop`, process.env, host);
