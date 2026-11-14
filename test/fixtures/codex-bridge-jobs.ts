import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../../src/harness.ts";
import { Runtimes } from "../../src/runtime/registry.ts";
import { Store } from "../../src/store.ts";
import { fixture } from "../codex-fixture.test.ts";
import { World } from "../fake.ts";

export const job = `job_${"a".repeat(64)}`;
export const envelope = JSON.stringify({
  kind: "dots_development_request",
  instance: "personal",
  job_id: job,
  origin_id: "dot",
  request_id: "one",
  prompt: "Inspect a fixture.",
});
export const setup = async () => {
  const f = await fixture();
  const world = new World();
  const d: Deps = {
    store: new Store(f.root),
    runtimes: new Runtimes("codex", () => f.rt),
    choice: () => ({ kind: "codex", source: "env" }),
    exec: world.exec,
    now: () => world.clock,
    agentCmd: "unused",
    doriCmd: "unused",
    host: () => world.host,
    usage: world.recorder,
  };
  const lead = await f.rt.create({ ...f.spec, role: "lead", name: "lead" });
  d.store.setRole("lead", lead);
  writeFileSync(
    join(f.root, "config.json"),
    JSON.stringify({
      codexBridgeAdapter: {
        module: "/not-loaded",
        configPath: "/not-read",
        instance: "personal",
      },
    }),
  );
  return { f, d, lead };
};
