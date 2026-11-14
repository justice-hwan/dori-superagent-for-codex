import { ready } from "../../src/lanes.ts";
import { harnessFixture } from "../codex-fixture.test.ts";

export async function readyLane() {
  const { f, d } = await harnessFixture();
  const ref = await f.rt.create(f.spec);
  const lead = await f.rt.create({ ...f.spec, role: "lead", name: "lead" });
  d.store.setRole("lead", lead);
  d.store.saveLane({
    key: "followup",
    sessionRef: ref,
    paneId: ref.id,
    tabId: "",
    brief: "",
    cwd: f.spec.cwd,
    status: "working",
    createdAt: d.now(),
    lastActivityAt: d.now(),
    nudges: 0,
    log: [],
  });
  await ready(d, "followup", "initial result", ["initial.json"]);
  return { f, d, ref };
}
