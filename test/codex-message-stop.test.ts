import { Database } from "bun:sqlite";
import { expect, onTestFinished, spyOn, test } from "bun:test";
import { takeInboxLock } from "../src/inbox-lock.ts";
import * as lifecycle from "../src/runtime/codex/close.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const action = JSON.stringify({
  version: 1,
  kind: "action",
  tool: "dori_start",
  arguments: { key: "audit", brief: "Inspect the paused fixture." },
});

test.each(["before", "after"] as const)(
  "duty paused %s watcher start reserves and dispatches nothing",
  async (when) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    d.store.setRole("lead", lead);
    await f.rt.startAgent(lead, { prompt: "Inspect the fixture." });
    const observed = Promise.withResolvers<void>();
    if (when === "before") {
      d.store.setStop(d.now(), "operator pause", "duty");
      f.finish(lead.id, action);
    }
    const before = f.requests.length;
    const stop = await f.rt.watchIdle(async (ref) => {
      if (ref.id === lead.id) observed.resolve();
    }, d);
    f.cleanup.push(stop);
    if (when === "after") {
      d.store.setStop(d.now(), "operator pause", "duty");
      f.finish(lead.id, action);
    }
    await observed.promise;
    using db = new Database(`${new CodexStore(f.root).path(lead.id)}.messages.sqlite`, { readonly: true });
    const actual = {
      lanes: d.store.lanes().map((lane) => lane.key),
      reservations: db.query("SELECT turn FROM effects").all(),
      dispatches: f.requests.slice(before).filter((r) => ["thread/start", "turn/start"].includes(String(r["method"])))
        .length,
    };
    console.info("DUTY_PAUSED", when, actual);
    expect(actual).toEqual({ lanes: [], reservations: [], dispatches: 0 });
  },
);

test("duty resume consumes a suppressed completed source once without new input or synthetic events", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  d.store.setRole("lead", lead);
  await f.rt.startAgent(lead, { prompt: "Inspect the fixture." });
  const paused = Promise.withResolvers<void>(),
    resumed = Promise.withResolvers<void>();
  const stop = await f.rt.watchIdle(async (ref) => {
    if (ref.id !== lead.id) return;
    if (d.store.stop("duty")) paused.resolve();
    else if (d.store.lane("audit")) resumed.resolve();
  }, d);
  f.cleanup.push(stop);
  d.store.setStop(d.now(), "operator pause", "duty");
  const source = f.finish(lead.id, action);
  await paused.promise;
  expect(d.store.lanes()).toEqual([]);
  const before = f.requests.length;
  d.store.clearStop("duty");
  await resumed.promise;
  using db = new Database(`${new CodexStore(f.root).path(lead.id)}.messages.sqlite`, { readonly: true });
  expect(db.query("SELECT turn,receipt FROM effects").all()).toEqual([{ turn: source.id, receipt: "delivered" }]);
  expect(d.store.lanes().map((lane) => lane.key)).toEqual(["audit"]);
  expect(f.requests.slice(before).filter((r) => r["method"] === "turn/start")).toHaveLength(2);
  expect(f.threads.get(lead.id)?.turns).toHaveLength(2);
});

test("duty stop during done preparation releases target guards and resumes the same bound source once", async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  const lane = await f.rt.create({ ...f.spec, role: "lane", env: { DORI_LANE: "audit" } });
  d.store.setRole("lead", lead);
  d.store.saveLane({
    key: "audit",
    sessionRef: lane,
    paneId: lane.id,
    tabId: "",
    brief: "fixture",
    cwd: f.spec.cwd,
    status: "ready",
    createdAt: d.now(),
    lastActivityAt: d.now(),
    nudges: 0,
    log: [],
    final: { text: "Evidence", evidence: ["fixture"], at: d.now() },
  });
  await f.rt.startAgent(lead, { prompt: "Close the ready audit." });
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>(),
    paused = Promise.withResolvers<void>(),
    resumed = Promise.withResolvers<void>();
  const original = lifecycle.prepareClose;
  let held = false;
  const preparation = spyOn(lifecycle, "prepareClose").mockImplementation(async (...args) => {
    const prepared = await original(...args);
    if (args[2].id === lane.id && prepared && !held) {
      held = true;
      entered.resolve();
      await proceed.promise;
    }
    return prepared;
  });
  onTestFinished(() => {
    proceed.resolve();
    preparation.mockRestore();
  });
  const stop = await f.rt.watchIdle(async (ref) => {
    if (ref.id !== lead.id) return;
    if (d.store.stop("duty")) paused.resolve();
    else if (d.store.lane("audit")?.status === "done") resumed.resolve();
  }, d);
  f.cleanup.push(stop);
  const before = f.requests.length;
  const source = f.finish(
    lead.id,
    JSON.stringify({ version: 1, kind: "action", tool: "dori_done", arguments: { key: "audit" } }),
  );
  await entered.promise;
  const store = new CodexStore(f.root);
  const inboxHeld = d.store.lockInbox(lane, d.now());
  inboxHeld?.();
  const submitHeld = takeInboxLock(`${store.path(lane.id)}.submit-lock`, Date.now());
  submitHeld?.();
  expect(inboxHeld).toBeUndefined();
  expect(submitHeld).toBeUndefined();
  d.store.setStop(d.now(), "pause during target preparation", "duty");
  proceed.resolve();
  await paused.promise;
  preparation.mockRestore();
  using db = new Database(`${store.path(lead.id)}.messages.sqlite`, { readonly: true });
  const binding = db.query("SELECT * FROM close_targets").all();
  expect(binding).toHaveLength(1);
  expect(db.query("SELECT * FROM effects").all()).toEqual([]);
  expect(db.query("SELECT * FROM observed WHERE turn=?").all(source.id)).toEqual([]);
  expect(db.query("SELECT * FROM submissions").all()).toHaveLength(1);
  expect(
    f.requests.slice(before).filter((r) => ["thread/unsubscribe", "turn/start"].includes(String(r["method"]))),
  ).toEqual([]);
  expect(d.store.lane("audit")?.status).toBe("ready");
  expect((await store.owned(lane)).closed).toBe(false);
  const inbox = d.store.lockInbox(lane, d.now());
  const submit = takeInboxLock(`${store.path(lane.id)}.submit-lock`, Date.now());
  try {
    expect(inbox).toBeFunction();
    expect(submit).toBeFunction();
  } finally {
    submit?.();
    inbox?.();
  }
  d.store.clearStop("duty");
  await resumed.promise;
  expect(db.query("SELECT * FROM close_targets").all()).toEqual(binding);
  expect(db.query("SELECT turn,state,receipt FROM effects").all()).toEqual([
    { turn: source.id, state: "completed", receipt: "delivered" },
  ]);
  expect(f.requests.slice(before).filter((r) => r["method"] === "thread/unsubscribe")).toHaveLength(1);
  expect(f.requests.slice(before).filter((r) => r["method"] === "turn/start")).toHaveLength(1);
  expect(f.threads.get(lead.id)?.turns).toHaveLength(2);
});
