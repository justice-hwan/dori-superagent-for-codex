import { expect, test } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { World } from "./fake.ts";
import { Store } from "../src/store.ts";
import { startLane, ready as readyAt, done as doneAt, report as reportAt, send, dutyTick, flushInbox, type Deps } from "../src/harness.ts";
import { acknowledge as acknowledgeAt, findTasks, pivot, taskDocument, taskFor, recoverTaskInputs } from "../src/tasks.ts";
import { acknowledgeNotice, flushNotices, notices, recordNotice } from "../src/notifications.ts";
import { MessengerJournal, type MessengerOrigin } from "../src/messenger.ts";
import { admitMessengerRequest } from "../src/messenger-bridge.ts";

const ready = (d: Deps, key: string, text: string, evidence: string[], revision?: number) => readyAt(d, key, text, evidence, revision, d.store.lane(key)!.threadId);
const done = (d: Deps, key: string) => doneAt(d, key, d.store.lane(key)!.threadId);
const report = (d: Deps, key: string, text: string, status?: "working" | "waiting", revision?: number) => reportAt(d, key, text, status, revision, d.store.lane(key)!.threadId);
const acknowledge = (d: Deps, key: string, revision: number) => acknowledgeAt(d, key, revision, d.store.lane(key)!.threadId);

async function fixture(title = "Login implementation", origin?: MessengerOrigin) {
  const world = new World(), d = world.deps(); world.addThread("work-lead"); world.addThread("conversation");
  d.store.setRole("lead", "work-lead"); d.store.setRole("conversation", "conversation");
  const brief = join(d.store.root, "input.md"); writeFileSync(brief, `# ${title}\nImplement and validate the requested task.`);
  const lane = await startLane(d, "login", brief, { cwd: d.store.root, origin });
  d.sessions.steer = async (id, text) => { world.threads.get(id)!.received.push(text); };
  return { world, d, lane, brief };
}

test("task lookup identifies one open lane and refuses ambiguous natural-language selection", async () => {
  const { d, brief } = await fixture(); await startLane(d, "login-next", brief, { cwd: d.store.root });
  expect(findTasks(d, "Login")).toHaveLength(2);
  expect(() => taskFor(d, "Login")).toThrow("ambiguous");
  expect(taskFor(d, "login").key).toBe("login");
  expect(() => taskFor(d, "missing topic")).toThrow("did not match");
});

test("split routes all raw start/report/READY to internal lead, completion once to conversation", async () => {
  const { world, d, lane } = await fixture();
  await report(d, lane.key, "unit tests in progress"); await ready(d, lane.key, "login complete", ["test proof"]); await done(d, lane.key);
  expect(world.threads.get("work-lead")!.received.join("\n")).toContain("[REPORT login]");
  expect(world.threads.get("conversation")!.received).toHaveLength(0);
  world.clock += 6000; await dutyTick(d); await dutyTick(d);
  expect(world.threads.get("conversation")!.received).toHaveLength(1);
  expect(world.threads.get("conversation")!.received[0]).toContain("login complete");
  expect(notices(d).notices).toHaveLength(1);
  const batch = notices(d).batches[0]!; expect(batch.submittedAt).toBe(world.clock);
  expect(notices(d).notices[0]!.acknowledgedAt).toBeUndefined();
  acknowledgeNotice(d, batch.id); expect(notices(d).notices[0]!.acknowledgedAt).toBe(world.clock);
});

test("active pivot steers, preserves ordinary send queue, and requires current model ACK", async () => {
  const { world, d, lane } = await fixture(); world.threads.get(lane.threadId)!.status = "working";
  expect(await send(d, lane.key, "ordinary follow-up", "conversation")).toBe("QUEUED");
  const updated = await pivot(d, lane.key, "Use email instead of Google", 1);
  expect(updated.revision).toBe(2); expect(updated.instructions!.at(-1)!.status).toBe("delivered");
  expect(world.threads.get(lane.threadId)!.received.at(-1)).toContain("REVISION 2");
  await expect(ready(d, lane.key, "old result", ["proof"], 1)).rejects.toThrow("stale");
  await expect(ready(d, lane.key, "new result", ["proof"], 2)).rejects.toThrow("acknowledge");
  acknowledge(d, lane.key, 2); await ready(d, lane.key, "email login complete", ["proof"], 2);
  world.threads.get(lane.threadId)!.status = "idle"; await done(d, lane.key);
  expect(taskDocument(taskFor(d, lane.key, true))).toContain("# 요약");
  expect(taskDocument(taskFor(d, lane.key, true))).toContain("# 정할 것");
  expect(taskDocument(taskFor(d, lane.key, true))).toContain("# 상세");
});

test("blocked pivots remain queued, two revisions supersede old READY and stale ACK/report", async () => {
  const { world, d, lane } = await fixture(); world.threads.get(lane.threadId)!.status = "blocked";
  expect((await pivot(d, lane.key, "Email login", 1)).instructions!.at(-1)!.status).toBe("queued");
  expect((await pivot(d, lane.key, "Email plus passkey", 2)).revision).toBe(3);
  expect(() => acknowledge(d, lane.key, 2)).toThrow("current");
  await expect(report(d, lane.key, "old waiting", "waiting", 2)).rejects.toThrow("stale");
  expect(d.store.lane(lane.key)!.status).toBe("working");
  world.threads.get(lane.threadId)!.status = "idle"; await dutyTick(d);
  const text = world.threads.get(lane.threadId)!.received.at(-1)!;
  expect(text.indexOf("REVISION 2")).toBeLessThan(text.indexOf("REVISION 3"));
  const reloaded = { ...d, store: new Store(d.store.root) };
  acknowledge(reloaded, lane.key, 3); await ready(reloaded, lane.key, "latest", ["proof"], 3);
  expect(reloaded.store.lane(lane.key)!.final?.revision).toBe(3);
});

test("old READY cannot race a pivot while the steer is awaiting its response", async () => {
  const { world, d, lane } = await fixture(); world.threads.get(lane.threadId)!.status = "working";
  let release!: () => void, entered!: () => void;
  const called = new Promise<void>(r => entered = r), wait = new Promise<void>(r => release = r);
  d.sessions.steer = async () => { entered(); await wait; };
  const inFlight = pivot(d, lane.key, "new direction", 1); await called;
  await expect(ready(d, lane.key, "old", ["proof"], 1)).rejects.toThrow("stale");
  expect(() => acknowledge(d, lane.key, 3)).toThrow();
  acknowledge(d, lane.key, 2); release(); await inFlight;
  expect(d.store.lane(lane.key)!.instructions!.at(-1)!.status).toBe("acknowledged");
});

test("write-ahead instruction recovery admits once and survives cursor acknowledgement", async () => {
  const { world, d, lane } = await fixture(); world.threads.get(lane.threadId)!.status = "blocked";
  const enqueue = d.store.enqueueOnce.bind(d.store); let fail = true;
  d.store.enqueueOnce = (id, message) => { if (fail) throw new Error("simulated crash before inbox append"); enqueue(id, message); };
  await expect(pivot(d, lane.key, "new direction", 1)).rejects.toThrow("simulated");
  expect(d.store.lane(lane.key)!.revision).toBe(2);
  fail = false; recoverTaskInputs(d); recoverTaskInputs(d);
  expect(d.store.queued(lane.threadId)).toHaveLength(1);
  world.threads.get(lane.threadId)!.status = "idle"; await flushInbox(d, lane.threadId); recoverTaskInputs(d);
  expect(d.store.queued(lane.threadId)).toHaveLength(0);
});

test("nearby completions batch together; urgent decisions do not pull unrelated completion forward", async () => {
  const { world, d, lane, brief } = await fixture(); const second = await startLane(d, "second", brief, { cwd: d.store.root });
  await ready(d, lane.key, "first done", ["a"]); await done(d, lane.key); await ready(d, second.key, "second done", ["b"]); await done(d, second.key);
  recordNotice(d, { task: second.key, instance: second.threadId, revision: 1, kind: "decision", summary: "Choose deployment", decision: "Deploy now?", details: [] });
  await flushNotices(d); const first = world.threads.get("conversation")!.received[0]!;
  expect(first).toContain("Choose deployment"); expect(first).not.toContain("first done");
  world.clock += 6000; await flushNotices(d);
  expect(world.threads.get("conversation")!.received[1]).toContain("first done");
  expect(world.threads.get("conversation")!.received[1]).toContain("second done");
  await flushNotices(d, true); expect(world.threads.get("conversation")!.received).toHaveLength(2);
});

test("notification restart after acceptance-before-journal-save does not replay the inbox message", async () => {
  const { world, d, lane } = await fixture();
  recordNotice(d, { task: lane.key, instance: lane.threadId, revision: 1, kind: "decision", summary: "A question", decision: "A or B?", details: [] });
  await flushNotices(d); const file = join(d.store.root, "notifications.json"), snapshot = JSON.parse(readFileSync(file, "utf8"));
  delete snapshot.batches[0].submittedAt; writeFileSync(file, JSON.stringify(snapshot));
  await flushNotices({ ...d, store: new Store(d.store.root) });
  expect(world.threads.get("conversation")!.received).toHaveLength(1);
  expect(notices(d).batches[0]!.submittedAt).toBeDefined();
});

test("external-origin completion is retained for that origin and never cross-posts into Codex", async () => {
  const { world, d, lane } = await fixture("External task", { platform: "slack", account: "account-a", workspace: "space", target: "channel-a", thread: "10.1", sourceMessage: "10.1" });
  await ready(d, lane.key, "external done", ["proof"]); await done(d, lane.key); world.clock += 6000; await dutyTick(d);
  expect(world.threads.get("conversation")!.received).toHaveLength(0);
  expect(notices(d).notices[0]!.origin?.target).toBe("channel-a");
});

test("authenticated messenger follow-up pivots the bound native instance once across dispatch retry", async () => {
  const origin = { platform: "slack" as const, account: "account-a", workspace: "space", target: "channel-a", thread: "10.1", sourceMessage: "10.1" };
  const { d, lane } = await fixture("External task", origin); const journal = new MessengerJournal(d.store.root);
  const event = { id: "event-2", origin: { ...origin, sourceMessage: "10.2" }, authorId: "owner", text: "Use email instead" };
  const options = { ownerId: "owner", verify: async () => true, task: lane.threadId };
  await admitMessengerRequest(d, event, options); await admitMessengerRequest(d, event, options);
  expect(d.store.lane(lane.key)!.revision).toBe(2);
  expect(journal.inbound()[0]!.handledAt).toBeDefined();
  await expect(admitMessengerRequest(d, { ...event, id: "evil", authorId: "other" }, options)).rejects.toThrow("verified owner");
});

test("a reused lane key cannot accept old-instance ACK/report/READY or closure", async () => {
  const { d, lane, brief } = await fixture(); await ready(d, lane.key, "first", ["proof"]); await done(d, lane.key);
  const replacement = await startLane(d, lane.key, brief, { cwd: d.store.root }); expect(replacement.threadId).not.toBe(lane.threadId);
  expect(() => acknowledgeAt(d, lane.key, 1, lane.threadId)).toThrow("instance");
  await expect(reportAt(d, lane.key, "old", "waiting", 1, lane.threadId)).rejects.toThrow("instance");
  await expect(readyAt(d, lane.key, "old", ["proof"], 1, lane.threadId)).rejects.toThrow("instance");
  await expect(doneAt(d, lane.key, lane.threadId)).rejects.toThrow("instance");
});

test("an uncertain accepted notification remains frozen and is never blindly replayed", async () => {
  const { world, d, lane } = await fixture();
  recordNotice(d, { task: lane.key, instance: lane.threadId, revision: 1, kind: "decision", summary: "Need a decision", decision: "Choose", details: [] });
  const deliver = d.sessions.deliver.bind(d.sessions); let accepted: string | undefined;
  d.sessions.deliver = async (id, text, batch) => {
    if (batch === accepted) return;
    await deliver(id, text, batch); accepted = batch; world.threads.get(id)!.status = "unknown";
    throw new Error("accepted response lost");
  };
  await expect(flushNotices(d)).rejects.toThrow("lost");
  const batch = notices(d).batches[0]!; expect(batch.submittedAt).toBeUndefined();
  expect(await flushNotices(d)).toBe(false); expect(notices(d).batches[0]!.id).toBe(batch.id);
  expect(world.threads.get("conversation")!.received).toHaveLength(1);
  // Authoritative acceptance readback is represented by restoring readiness; exact batch dedup handles retry.
  world.threads.get("conversation")!.status = "idle"; await flushNotices(d);
  expect(world.threads.get("conversation")!.received).toHaveLength(1);
});

test("committed DONE recovers notification after outbox failure and key reuse across restart", async () => {
  const { world, d, lane, brief } = await fixture(); await ready(d, lane.key, "old verified result", ["proof"]);
  const { acquireFileLease } = await import("../src/lock.ts"); const lease = acquireFileLease(join(d.store.root, "notifications.json.lock"))!;
  try { await done(d, lane.key); expect(d.store.lane(lane.key)!.status).toBe("done"); expect(notices(d).notices).toHaveLength(0); }
  finally { lease.release(); }
  const replacement = await startLane(d, lane.key, brief, { cwd: d.store.root });
  expect(replacement.completions).toHaveLength(1); expect(replacement.completions![0]!.instance).toBe(lane.threadId);
  const reloaded = { ...d, store: new Store(d.store.root) }; world.clock += 6000; await dutyTick(reloaded); await dutyTick(reloaded);
  expect(notices(reloaded).notices).toHaveLength(1);
  expect(world.threads.get("conversation")!.received).toHaveLength(1);
  expect(world.threads.get("conversation")!.received[0]).toContain("old verified result");
});

// Exact adversarial regressions for independent review 043a35e.
test("an unsent notice ID cannot suppress delivery, and receipts require the submitted captured batch", async () => {
  const { world, d, lane } = await fixture();
  const n = recordNotice(d, { task: lane.key, instance: lane.threadId, revision: 1, kind: "decision", summary: "Owner must choose", decision: "A or B?", details: [] })!;
  expect(() => acknowledgeNotice(d, n.id)).toThrow("submitted batch"); expect(notices(d).notices[0]!.acknowledgedAt).toBeUndefined();
  await flushNotices(d); expect(world.threads.get("conversation")!.received).toHaveLength(1);
  expect(() => acknowledgeNotice(d, n.id)).toThrow("submitted batch");
  const batch = notices(d).batches[0]!;
  const file = join(d.store.root, "notifications.json"), data = JSON.parse(readFileSync(file, "utf8"));
  data.batches[0].target = "wrong-conversation"; writeFileSync(file, JSON.stringify(data));
  expect(() => acknowledgeNotice(d, batch.id)).toThrow("submitted batch");
  data.batches[0].target = "conversation"; writeFileSync(file, JSON.stringify(data));
  acknowledgeNotice({ ...d, store: new Store(d.store.root) }, batch.id); expect(notices(d).notices[0]!.acknowledgedAt).toBeDefined();
});

test("messenger origin is present before kickoff and cannot be retrofitted after a fast completion", async () => {
  const { world, d, brief } = await fixture();
  const origin: MessengerOrigin = { platform: "slack", account: "a", workspace: "w", target: "private", thread: "10.1", sourceMessage: "10.1" };
  const deliver = d.sessions.deliver.bind(d.sessions); let checked = false;
  d.sessions.deliver = async (id, text, batch) => {
    const lane = d.store.lanes().find(l => l.threadId === id);
    if (lane?.key === "external") {
      checked = true; expect(lane.origin).toEqual({ kind: "messenger", origin });
      expect(new MessengerJournal(d.store.root).origin(id)).toEqual(origin);
    }
    await deliver(id, text, batch);
  };
  const external = await startLane(d, "external", brief, { cwd: d.store.root, origin }); expect(checked).toBe(true);
  await ready(d, external.key, "Private external result", ["private proof"]); await done(d, external.key);
  world.clock += 6000; const events = [...await dutyTick(d), ...await dutyTick(d)];
  expect(events.some(e => e.action === "notification-pending")).toBe(false);
  expect(world.threads.get("conversation")!.received).toHaveLength(0);
  expect(notices(d).notices[0]!.route).toEqual({ kind: "messenger", origin });
  const local = d.store.lane("login")!; await ready(d, local.key, "local result", ["proof"]); await done(d, local.key);
  expect(() => new MessengerJournal(d.store.root).bindTask(local.threadId, origin)).toThrow("Codex origin");
  expect(d.store.lane(local.key)!.origin).toEqual({ kind: "codex", threadId: "conversation" });
});

test("unknown legacy origin is held and late binding cannot retarget an already admitted task", async () => {
  const { world, d, lane } = await fixture(); const file = join(d.store.root, "lanes", `${lane.key}.json`);
  const old = JSON.parse(readFileSync(file, "utf8")); delete old.origin; writeFileSync(file, JSON.stringify(old));
  const n = recordNotice(d, { task: lane.key, instance: lane.threadId, revision: 1, kind: "decision", summary: "Legacy private decision", decision: "Choose", details: [] })!;
  expect(n.route).toEqual({ kind: "unknown" });
  expect(() => new MessengerJournal(d.store.root).bindTask(lane.threadId, { platform: "slack", account: "a", target: "private" })).toThrow("before task admission");
  await flushNotices(d, true); expect(world.threads.get("conversation")!.received).toHaveLength(0);
  expect(notices(d).notices[0]!.origin).toBeUndefined();
});

test("a crash before atomic DONE cannot publish a stale candidate after pivot, lost state and key reuse", async () => {
  const { world, d, lane, brief } = await fixture(); await ready(d, lane.key, "Old uncommitted result", ["proof-r1"]);
  const save = d.store.saveLane.bind(d.store); let fail = true;
  d.store.saveLane = value => { if (value.status === "done" && fail) { fail = false; throw new Error("crash before DONE commit"); } save(value); };
  await expect(done(d, lane.key)).rejects.toThrow("crash");
  expect(d.store.lane(lane.key)!.completions ?? []).toHaveLength(0);
  await expect(pivot(d, lane.key, "New direction", 1)).rejects.toThrow("gone");
  await dutyTick(d); expect(d.store.lane(lane.key)!.status).toBe("lost");
  const replacement = await startLane(d, lane.key, brief, { cwd: d.store.root }); expect(replacement.threadId).not.toBe(lane.threadId);
  // Preserve a pre-fix outbox candidate, including an apparently valid local route.
  const candidate = { id: "old-candidate", task: lane.key, instance: lane.threadId, revision: 1, kind: "completion", summary: "Old uncommitted result", decision: "없음", details: ["proof-r1"], route: { kind: "codex", threadId: "conversation" }, at: world.clock };
  writeFileSync(join(d.store.root, "notifications.json"), JSON.stringify({ notices: [candidate], batches: [] }));
  world.clock += 6000; await flushNotices({ ...d, store: new Store(d.store.root) }, true);
  expect(world.threads.get("conversation")!.received).toHaveLength(0); expect(notices(d).notices).toHaveLength(1);
  expect(notices(d).notices[0]!.acknowledgedAt).toBeUndefined();
});

test("closed messenger native instance never falls back to another task's substring match", async () => {
  const a: MessengerOrigin = { platform: "slack", account: "a", target: "channel-a", thread: "10.1", sourceMessage: "10.1" };
  const { d, lane, brief } = await fixture("Original", a); await ready(d, lane.key, "A done", ["a"]); await done(d, lane.key);
  writeFileSync(brief, `# Follow-up of ${lane.threadId}\nUnrelated task`);
  const b = await startLane(d, "other", brief, { cwd: d.store.root, origin: { ...a, target: "channel-b" } });
  expect(() => taskFor(d, lane.threadId)).toThrow("exact task instance is closed");
  const event = { id: "follow-up", origin: { ...a, sourceMessage: "10.2" }, authorId: "owner", text: "Change A" };
  for (const current of [d, { ...d, store: new Store(d.store.root) }]) await expect(admitMessengerRequest(current, event, { ownerId: "owner", verify: async () => true, task: lane.threadId })).rejects.toThrow("not open");
  expect(d.store.lane(b.key)!.revision).toBe(1); expect(new MessengerJournal(d.store.root).inbound()[0]!.handledAt).toBeUndefined();
});
