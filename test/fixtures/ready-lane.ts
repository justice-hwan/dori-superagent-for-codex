import { expect } from "bun:test";
import { DeliveryUncertain } from "../../src/delivery.ts";
import { flushInbox } from "../../src/inbox.ts";
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

export async function acceptedHeld(count = 1) {
  const s = await readyLane();
  for (let i = 0; i < count; i++) s.d.store.enqueue(s.ref, { at: s.d.now(), from: "lead", text: `task-${i + 1}` });
  s.f.admission("accept-disconnect");

  await expect(flushInbox(s.d, s.ref)).rejects.toBeInstanceOf(DeliveryUncertain);

  expect(s.d.store.queued(s.ref).map((message) => message.attempt?.state)).toEqual(
    Array.from({ length: count }, () => "ambiguous"),
  );
  expect(await s.f.rt.confirmedDelivery(s.ref)).toBeUndefined();
  expect(s.f.threads.get(s.ref.id)?.items.filter((item) => item["type"] === "userMessage")).toHaveLength(1);
  s.f.finish(s.ref.id, "accepted followup completed without READY");
  s.f.admission("accept");
  return s;
}
