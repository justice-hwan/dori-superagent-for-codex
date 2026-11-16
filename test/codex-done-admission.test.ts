import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { callBridgeTool, type BridgeScope } from "../src/runtime/codex/bridge-tools.ts";
import { prepareBridgeDone, readDoneTarget } from "../src/runtime/codex/done-admission.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { saveSubmissionJournal } from "../src/submission-journal.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

const setup = async () => {
  const { f, d } = await harnessFixture();
  const lead = await f.rt.create({ ...f.spec, role: "lead", name: "lead" });
  d.store.setRole("lead", lead);
  const scope: BridgeScope = {
    root: realpathSync(f.root),
    cwd: realpathSync(f.spec.cwd),
    role: "lead",
    key: "",
    id: lead.id,
  };
  await callBridgeTool(d, scope, "dori_start", { key: "audit", brief: "Inspect the fixture." });
  const lane = d.store.lane("audit");
  if (!lane) throw new Error("Missing actual lane");
  f.finish(lane.sessionRef.id, "finished");
  await callBridgeTool(d, { ...scope, role: "lane", key: lane.key, id: lane.sessionRef.id }, "dori_ready", {
    text: "Inspected.",
    evidence: ["file:///fixture/result"],
  });
  const store = new CodexStore(f.root);
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  const target = readDoneTarget(d, lane.key, scope.cwd);
  const prepare = () => prepareBridgeDone({ d, scope, target, store, connection });
  return { f, d, scope, store, connection, target, lane, lead, prepare };
};

test.each(["inbox", "submit", "both"] as const)(
  "actual %s contention defers before any native action and releases only acquired resources",
  async (resource) => {
    const s = await setup();
    const inbox = resource !== "submit" ? s.d.store.lockInbox(s.lane.sessionRef, Date.now()) : undefined;
    const submit =
      resource !== "inbox" ? takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now()) : undefined;
    expect(resource === "submit" || inbox !== undefined).toBe(true);
    expect(resource === "inbox" || submit !== undefined).toBe(true);
    const before = [...s.f.calls];
    try {
      expect(await s.prepare()).toEqual({
        kind: "deferred",
        resource: resource === "submit" ? "submit" : "inbox",
        id: s.target.id,
      });
      expect(s.f.calls).toEqual(before);
      expect(s.d.store.lane("audit")?.status).toBe("ready");
      expect((await s.store.owned(s.lane.sessionRef)).closed).toBe(false);
      if (resource === "submit") {
        const freeInbox = s.d.store.lockInbox(s.lane.sessionRef, Date.now());
        expect(freeInbox).toBeDefined();
        freeInbox?.();
      }
      if (resource === "inbox") {
        const freeSubmit = takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now());
        expect(freeSubmit).toBeDefined();
        freeSubmit?.();
      }
    } finally {
      submit?.();
      inbox?.();
    }
    const prepared = await s.prepare();
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error("Target was not released");
    using owned = prepared;
    await owned.execute();
    expect(s.d.store.lane("audit")?.status).toBe("done");
    expect((await s.store.owned(s.lane.sessionRef, true)).closed).toBe(true);
    expect(s.f.calls.slice(before.length).filter((call) => call === "thread/unsubscribe")).toHaveLength(1);
    expect(s.f.calls.slice(before.length).filter((call) => call === "turn/start")).toHaveLength(0);
  },
);

test("prepared actual done retains both target resources, never takes source inbox, and is single use", async () => {
  const s = await setup();
  const sourceInbox = s.d.store.lockInbox(s.lead, Date.now());
  expect(sourceInbox).toBeDefined();
  try {
    const before = [...s.f.calls];
    const prepared = await s.prepare();
    if (prepared.kind !== "prepared") throw new Error("Unexpected deferral");
    try {
      expect(s.f.calls).toEqual(before);
      expect(s.d.store.lockInbox(s.lane.sessionRef, Date.now())).toBeUndefined();
      expect(takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now())).toBeUndefined();
      await expect(s.f.rt.close(s.lane.sessionRef)).rejects.toThrow("A submission is still in progress");
      await prepared.execute();
      await expect(prepared.execute()).rejects.toThrow("already");
      expect(s.d.store.lockInbox(s.lane.sessionRef, Date.now())).toBeUndefined();
      expect(takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now())).toBeUndefined();
    } finally {
      prepared[Symbol.dispose]();
      prepared[Symbol.dispose]();
    }
    const inbox = s.d.store.lockInbox(s.lane.sessionRef, Date.now());
    const submit = takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now());
    expect(inbox).toBeDefined();
    expect(submit).toBeDefined();
    submit?.();
    inbox?.();
  } finally {
    sourceInbox?.();
  }
});

test("disposing an unexecuted prepared target performs no native lifecycle work", async () => {
  const s = await setup();
  const before = [...s.f.calls];
  const prepared = await s.prepare();
  if (prepared.kind !== "prepared") throw new Error("Unexpected deferral");
  prepared[Symbol.dispose]();
  await expect(prepared.execute()).rejects.toThrow("already");
  expect(s.f.calls).toEqual(before);
  expect(s.d.store.lane("audit")?.status).toBe("ready");
});

test.each([
  "source-registration",
  "source-role",
  "source-endpoint",
  "source-desktop",
  "source-uncertain",
  "target-role",
  "target-key",
  "target-endpoint",
  "target-desktop",
  "target-uncertain",
  "target-pending",
  "target-confirmed",
  "target-closed",
  "target-workspace",
  "ready-generation",
  "admission-generation",
  "journal-generation",
  "replacement",
] as const)("preparation rejects changed %s with zero native calls", async (change) => {
  const s = await setup();
  const source = await s.store.owned(s.lead);
  const target = await s.store.owned(s.lane.sessionRef);
  const lane = s.d.store.lane("audit");
  if (!lane?.final) throw new Error("Missing actual READY");
  switch (change) {
    case "source-registration":
      s.d.store.setRole("lead", s.lane.sessionRef);
      break;
    case "source-role":
      await s.store.save({ ...source, spec: { ...source.spec, role: "duty" } });
      break;
    case "source-endpoint":
      await s.store.save({ ...source, envelope: { version: 1, endpoint: "ws://elsewhere" } });
      break;
    case "source-desktop":
      await s.store.save({ ...source, desktopOwned: true });
      break;
    case "source-uncertain":
      await s.store.save({ ...source, uncertain: "held" });
      break;
    case "target-role":
      await s.store.save({ ...target, spec: { ...target.spec, role: "lead" } });
      break;
    case "target-key":
      await s.store.save({ ...target, spec: { ...target.spec, env: { DORI_LANE: "other" } } });
      break;
    case "target-endpoint":
      await s.store.save({ ...target, envelope: { version: 1, endpoint: "ws://elsewhere" } });
      break;
    case "target-desktop":
      await s.store.save({ ...target, desktopOwned: true });
      break;
    case "target-uncertain":
      await s.store.save({ ...target, uncertain: "held" });
      break;
    case "target-pending":
      await s.store.save({ ...target, admission: "pending" });
      break;
    case "target-confirmed":
      await s.store.save({ ...target, confirmed: { id: crypto.randomUUID(), messageIds: ["new"] } });
      break;
    case "target-closed":
      await s.store.save({ ...target, closed: true });
      break;
    case "target-workspace":
      await s.store.save({ ...target, spec: { ...target.spec, cwd: s.f.root } });
      break;
    case "ready-generation":
      s.d.store.saveLane({ ...lane, final: { ...lane.final, at: lane.final.at + 1 } });
      break;
    case "admission-generation":
      s.d.store.saveLane({ ...lane, admissionId: crypto.randomUUID(), admissionOrder: 999 });
      break;
    case "journal-generation":
      saveSubmissionJournal(s.d, lane.sessionRef, { admitted: { id: crypto.randomUUID(), order: 999 } });
      break;
    case "replacement":
      s.d.store.saveLane({ ...lane, sessionRef: s.lead });
      break;
  }
  const before = [...s.f.calls];
  await expect(s.prepare()).rejects.toThrow();
  expect(s.f.calls).toEqual(before);
  const inbox = s.d.store.lockInbox(s.lane.sessionRef, Date.now());
  const submit = takeInboxLock(`${s.store.path(s.target.id)}.submit-lock`, Date.now());
  expect(inbox).toBeDefined();
  expect(submit).toBeDefined();
  submit?.();
  inbox?.();
});

test.each(["thread/read", "thread/unsubscribe"])(
  "changed target during %s is never closed over or overwritten as done",
  async (method) => {
    const s = await setup();
    const prepared = await s.prepare();
    if (prepared.kind !== "prepared") throw new Error("Unexpected deferral");
    using owned = prepared;
    s.f.onRequest((request) => {
      if (request["method"] !== method) return;
      s.d.store.saveLane({ ...s.lane, sessionRef: s.lead, status: "working" });
    });
    const before = s.f.calls.length;
    await expect(owned.execute()).rejects.toThrow();
    expect(s.d.store.lane("audit")?.sessionRef.id).toBe(s.lead.id);
    expect(s.d.store.lane("audit")?.status).toBe("working");
    expect(s.f.calls.slice(before).filter((call) => call === "thread/unsubscribe")).toHaveLength(
      method === "thread/read" ? 0 : 1,
    );
  },
);
