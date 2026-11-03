import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { MessengerRunner, runnerConfig, runnerStatus, requestRunnerStop, readRunnerConfig, runnerExample, type RunnerConfig, type RunnerIO, type RunnerSocket } from "../src/messenger-runner.ts";
import { MessengerJournal, tsAfter, type HttpRequest, type Platform } from "../src/messenger.ts";
import { startLane, ready, done, flushInbox } from "../src/harness.ts";
import { acknowledge } from "../src/tasks.ts";
import { notices, recordNotice } from "../src/notifications.ts";
import { main } from "../src/cli.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";

const ok = (body: unknown, status = 200) => ({ status, headers: {}, body: JSON.stringify(body) });
class Socket implements RunnerSocket {
  frames: any[] = []; closed = false;
  message = (_raw: string) => {}; closedHandler = () => {};
  send(data: string) { this.frames.push(JSON.parse(data)); }
  close() { this.closed = true; this.closedHandler(); }
  onMessage(cb: (raw: string) => void) { this.message = cb; }
  onClose(cb: () => void) { this.closedHandler = cb; }
  emit(data: unknown) { this.message(JSON.stringify(data)); }
}
function fixture(platform: Platform = "telegram", patch: Partial<RunnerConfig> = {}) {
  const world = new World(), d = world.deps();
  world.addThread("work-lead"); world.addThread("conversation");
  d.store.setRole("lead", "work-lead"); d.store.setRole("conversation", "conversation");
  d.sessions.steer = async (id, text) => { world.threads.get(id)!.received.push(text); };
  const config = runnerConfig({ enabled: true, platform, credential: "FAKE-EXPLICIT-SECRET", account: "1", ownerId: "2", targets: [platform === "telegram" ? "-20" : "20"],
    ...(platform !== "telegram" ? { workspace: "30" } : {}), ...(platform === "slack" ? { since: "99.000000" } : {}), ...(platform === "discord" ? { after: { "20": "0" } } : {}), ...patch }) as RunnerConfig;
  const seen: HttpRequest[] = [], sockets: Socket[] = [], timers = new Map<number, { cb: () => void; ms: number }>();
  let timerId = 0;
  const telegram: any[] = [], slack: any[] = [], discord: any[] = [];
  let override: ((r: HttpRequest) => ReturnType<typeof ok> | Promise<ReturnType<typeof ok>> | undefined) | undefined;
  const io: RunnerIO = {
    clock: { now: () => world.clock, sleep: async ms => { world.clock += ms; } },
    timers: { setInterval: (cb, ms) => { const id = ++timerId; timers.set(id, { cb, ms }); return id; }, clearInterval: id => { timers.delete(id as number); } },
    openSocket: () => { const s = new Socket(); sockets.push(s); return s; },
    http: async r => {
      seen.push(r); const special = override?.(r); if (special) return await special;
      const method = r.url.split("/").pop();
      const params = r.body ? JSON.parse(String(r.body)) : {};
      if (method === "getMe") return ok({ ok: true, result: { id: 1, is_bot: true } });
      if (method === "getWebhookInfo") return ok({ ok: true, result: { url: "" } });
      if (method === "getUpdates") return ok({ ok: true, result: telegram.filter(e => e.update_id >= params.offset) });
      if (method === "sendMessage") return ok({ ok: true, result: { message_id: 100 } });
      if (method === "auth.test") return ok({ ok: true, user_id: "1", team_id: "30" });
      if (method === "conversations.history" || method === "conversations.replies") return ok({ ok: true, messages: slack.filter(e => tsAfter(e.ts, params.oldest) && (method === "conversations.history" ? !e.thread_ts : e.thread_ts === params.ts)).reverse() });
      if (method === "subscriptions.thread.getView") return ok({ ok: true, threads: [] });
      if (method === "client.counts") return ok({ ok: true, channels: [], ims: [], mpims: [] });
      if (method === "chat.postMessage") return ok({ ok: true, channel: params.channel, ts: "150.000001" });
      if (r.url.endsWith("/users/@me")) return ok({ id: "1", bot: true });
      if (r.url.endsWith("/gateway/bot")) return ok({ url: "wss://gateway.discord.gg" });
      if (r.url.endsWith("/channels/20")) return ok({ id: "20", guild_id: "30", type: 0 });
      if (r.url.includes("/messages?")) return ok([...discord].reverse());
      if (r.url.endsWith("/messages")) return ok({ id: "999" });
      throw new Error("unexpected fixture HTTP");
    },
  };
  const runner = new MessengerRunner(d, config, io);
  const emit = async (body: unknown) => { sockets.at(-1)!.emit(body); await runner.drained(); };
  const connected = async () => {
    await emit({ op: 10, d: { heartbeat_interval: 10_000 } });
    await emit({ op: 0, s: 1, t: "READY", d: { user: { id: "1", bot: true }, session_id: "session-fixture", resume_gateway_url: "wss://gateway-us-east1-b.discord.gg" } });
  };
  const inbound = async (id = 1, text = "Implement owner request") => {
    if (platform === "telegram") { telegram.push({ update_id: id, message: { message_id: id + 10, chat: { id: -20 }, message_thread_id: 7, from: { id: 2, is_bot: false }, text } }); await runner.tick(); }
    else if (platform === "slack") { slack.push({ ts: `${99 + id}.000001`, user: "2", text, ...(id > 1 ? { thread_ts: "100.000001" } : {}) }); await runner.tick(); }
    else await emit({ op: 0, s: id + 1, t: "MESSAGE_CREATE", d: { id: String(100 + id), channel_id: "20", guild_id: "30", author: { id: "2", bot: false }, content: text, type: 0 } });
  };
  const sent = () => seen.filter(r => /\/(sendMessage|chat.postMessage|messages)$/.test(r.url));
  return { world, d, config, io, runner, seen, sent, sockets, timers, telegram, slack, discord, emit, connected, inbound, override: (f: typeof override) => { override = f; } };
}
async function allocate(f: ReturnType<typeof fixture>) {
  const text = f.world.threads.get("work-lead")!.received.find(t => t.includes("[MESSENGER REQUEST"))!;
  expect(text).toContain("Origin file:");
  const file = JSON.parse(text.split("Origin file: ")[1]!.split("\n")[0]!);
  const origin = JSON.parse(readFileSync(file, "utf8"));
  const brief = join(f.d.store.root, "request.md"); writeFileSync(brief, "# Owner work\nImplement authorized owner request.");
  const lane = await startLane(f.d, "owner-work", brief, { cwd: f.d.store.root, origin });
  return { lane, origin, brief };
}

for (const platform of ["telegram", "slack", "discord"] as const) test(`${platform}: authenticated inbound -> real harness allocation -> exact pivot ACK -> DONE -> automatic original-route reply`, async () => {
  const f = fixture(platform);
  try {
    await f.runner.start(); if (platform === "discord") await f.connected();
    await f.inbound(); const { lane, origin } = await allocate(f);
    expect(lane.origin).toEqual({ kind: "messenger", origin });
    f.world.threads.get(lane.threadId)!.status = "working";
    await f.inbound(2, "TASK REVISION: use the revised design");
    expect(f.d.store.lane(lane.key)!.revision).toBe(2);
    await expect(ready(f.d, lane.key, "old", ["proof"], 1, lane.threadId)).rejects.toThrow("stale");
    await expect(ready(f.d, lane.key, "new", ["proof"], 2, lane.threadId)).rejects.toThrow("acknowledge");
    expect(() => acknowledge(f.d, lane.key, 2, "wrong-instance")).toThrow("instance");
    acknowledge(f.d, lane.key, 2, lane.threadId);
    await ready(f.d, lane.key, "verified result", ["fixture-evidence"], 2, lane.threadId);
    await f.runner.tick(); expect(f.sent()).toHaveLength(0);
    f.world.threads.get(lane.threadId)!.status = "idle";
    await done(f.d, lane.key, lane.threadId);
    await f.runner.tick(); await f.runner.tick();
    expect(f.sent()).toHaveLength(1); expect(notices(f.d).notices[0]!.externalReceipt).toBeTruthy();
    const send = f.sent()[0]!, body = JSON.parse(String(send.body));
    if (platform === "telegram") { expect(body.chat_id).toBe("-20"); expect(body.message_thread_id).toBe(7); }
    if (platform === "slack") { expect(body.channel).toBe("20"); expect(body.thread_ts).toBe("100.000001"); }
    if (platform === "discord") { expect(send.url).toEndWith("/channels/20/messages"); expect(body.allowed_mentions).toEqual({ parse: [] }); }
    expect(f.world.threads.get("conversation")!.received).toEqual([]);
    expect(f.world.threads.get("work-lead")!.received.some(t => t.includes("REVISION") || t.includes("[PIVOT"))).toBe(true);
    const state = readFileSync(join(f.d.store.root, "messenger", "runners", `${f.runner.state.id}.json`), "utf8"); expect(state).not.toContain("FAKE-EXPLICIT-SECRET");
  } finally { await f.runner.stop(); }
});

test("disabled/missing configuration and imports perform no provider IO or credential lookup", async () => {
  const f = fixture(); await f.runner.stop();
  const disabled = { enabled: false, get credential(): never { throw new Error("credential lookup forbidden"); } };
  expect(runnerConfig(disabled)).toEqual({ enabled: false });
  expect(() => runnerConfig({})).toThrow("explicit");
  expect(() => readRunnerConfig("relative.json")).toThrow("absolute");
  const file = join(f.d.store.root, "disabled.json"); writeFileSync(file, JSON.stringify({ enabled: false }));
  expect(await main(["messenger", "start", "--config", file], f.d)).toBe(0);
  await expect(main(["messenger", "start"], f.d)).rejects.toThrow("--config");
  expect(f.seen).toHaveLength(0); expect(f.sockets).toHaveLength(0);
  for (const platform of ["telegram", "slack", "discord"]) expect(runnerExample(platform).enabled).toBe(false);
});

test("startup checks authenticated account/workspace; mismatches fail before inbound or replies", async () => {
  for (const platform of ["telegram", "slack", "discord"] as const) {
    const f = fixture(platform);
    f.override(r => r.url.endsWith("getMe") ? ok({ ok: true, result: { id: 999, is_bot: true } }) : r.url.endsWith("auth.test") ? ok({ ok: true, user_id: "1", team_id: "WRONG" }) : r.url.endsWith("/users/@me") ? ok({ id: "wrong", bot: true }) : undefined);
    try { await expect(f.runner.start()).rejects.toThrow("startup failed"); expect(f.sent()).toHaveLength(0); expect(f.sockets).toHaveLength(0); }
    finally { await f.runner.stop(); }
  }
});
test("Telegram never deletes existing webhooks implicitly", async () => {
  const f = fixture(); f.override(r => r.url.endsWith("getWebhookInfo") ? ok({ ok: true, result: { url: "https://existing.invalid/hook" } }) : undefined);
  try { await expect(f.runner.start()).rejects.toThrow("startup failed"); expect(f.seen.some(r => r.url.includes("deleteWebhook"))).toBe(false); }
  finally { await f.runner.stop(); }
});

test("Telegram duplicate delivery and durable offset survive service restart without re-pivot", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f); await f.inbound(2, "pivot");
  const count = f.world.threads.get(lane.threadId)!.received.length;
  await f.runner.stop();
  const again = new MessengerRunner({ ...f.d, store: new Store(f.d.store.root) }, f.config, f.io);
  try { await again.start(); await again.tick(); expect(again.state.telegramOffset).toBe(3); expect(f.d.store.lane(lane.key)!.revision).toBe(2); expect(f.world.threads.get(lane.threadId)!.received).toHaveLength(count); }
  finally { await again.stop(); }
});
test("inbound crash between journal and ledger admission retains offset and recovers exactly once", async () => {
  const f = fixture(); await f.runner.start();
  const enqueue = f.d.store.enqueueOnce.bind(f.d.store); let crash = true;
  f.d.store.enqueueOnce = (id, m) => { if (crash) throw new Error("simulated admission crash"); enqueue(id, m); };
  await f.inbound(); expect(f.runner.state.telegramOffset).toBe(0); expect(new MessengerJournal(f.d.store.root).inbound()[0]!.handledAt).toBeUndefined();
  await f.runner.stop(); crash = false;
  const again = new MessengerRunner(f.d, f.config, f.io);
  try { await again.start(); await again.tick(); expect(again.state.telegramOffset).toBe(2); expect(f.world.threads.get("work-lead")!.received.filter(t => t.includes("MESSENGER REQUEST"))).toHaveLength(1); }
  finally { await again.stop(); }
});
test("native delivery uncertainty stays in the durable harness inbox with no blind replay", async () => {
  const f = fixture(); await f.runner.start();
  let nativeCalls = 0; f.d.sessions.deliver = async () => { nativeCalls++; f.world.threads.get("work-lead")!.status = "unknown"; throw new Error("response lost after native acceptance"); };
  try {
    await f.inbound(); await f.runner.tick(); await flushInbox(f.d, "work-lead");
    expect(nativeCalls).toBe(1); expect(f.d.store.queued("work-lead")).toHaveLength(1);
    expect(f.d.store.inboxBatch("work-lead")?.messages).toHaveLength(1); expect(f.runner.state.telegramOffset).toBe(2);
  } finally { await f.runner.stop(); }
});
test("Telegram malformed, unauthorized, forwarded, quoted and bot events are ignored durably", async () => {
  const f = fixture(); await f.runner.start();
  const base = { message_id: 11, chat: { id: -20 }, from: { id: 2, is_bot: false }, text: "owner text" };
  const patches = [{ from: { id: 3, is_bot: false } }, { from: { id: 2, is_bot: true } }, { quote: {} }, { forward_origin: {} }, { via_bot: {} }, { sender_chat: {} }, { chat: { id: -99 } }, { text: "" }, { message_thread_id: "7" }];
  f.telegram.push(...patches.map((patch, i) => ({ update_id: i + 1, message: { ...base, ...patch } })), { update_id: 10, edited_message: base });
  try { await f.runner.tick(); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); expect(f.runner.state.telegramOffset).toBe(11); expect(Object.values(f.runner.state.rejected).reduce((a, b) => a + b, 0)).toBe(10); }
  finally { await f.runner.stop(); }
});

test("two open bound instances on the same route cannot silently select or retarget a follow-up", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { origin, brief } = await allocate(f);
  await startLane(f.d, "second", brief, { cwd: f.d.store.root, origin });
  try { await f.inbound(2, "ambiguous pivot"); expect(f.runner.state.telegramOffset).toBe(2); expect(f.runner.state.issue).toBe("cycle-unconfirmed"); expect(f.d.store.lane("owner-work")!.revision).toBe(1); expect(f.d.store.lane("second")!.revision).toBe(1); }
  finally { await f.runner.stop(); }
});
test("persisted follow-up cannot move to a replacement task after bound instance closes", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane, origin, brief } = await allocate(f);
  const original = f.d.store.enqueueOnce.bind(f.d.store); let crash = true;
  f.d.store.enqueueOnce = (id, m) => { if (id === lane.threadId && crash) throw new Error("crash at pivot inbox"); original(id, m); };
  await f.inbound(2, "exact instance pivot"); expect(new MessengerJournal(f.d.store.root).inbound().at(-1)!.task).toBe(lane.threadId);
  f.d.store.editLane(lane.key, l => { l.status = "lost"; }); crash = false;
  const replacement = await startLane(f.d, lane.key, brief, { cwd: f.d.store.root, origin });
  try { await f.runner.tick(); expect(f.d.store.lane(lane.key)!.threadId).toBe(replacement.threadId); expect(f.d.store.lane(lane.key)!.revision).toBe(1); expect(f.runner.state.telegramOffset).toBe(2); }
  finally { await f.runner.stop(); }
});

test("unknown outbound response is durable uncertainty; ticks/restart never resend or fan out", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f);
  await ready(f.d, lane.key, "result", ["fixture"], 1, lane.threadId); await done(f.d, lane.key, lane.threadId);
  f.override(r => { if (r.url.endsWith("sendMessage")) throw new Error("FAKE-EXPLICIT-SECRET lost after send"); return undefined; });
  await f.runner.tick(); await f.runner.tick(); expect(f.sent()).toHaveLength(1); expect(new MessengerJournal(f.d.store.root).outgoing()[0]!.state).toBe("uncertain");
  expect(f.runner.state.blockedDeliveries).toHaveLength(1); await f.runner.stop();
  const again = new MessengerRunner(f.d, f.config, f.io);
  try {
    await again.start(); await again.tick(); expect(f.sent()).toHaveLength(1); expect(f.world.threads.get("conversation")!.received).toHaveLength(0); expect(JSON.stringify(runnerStatus(f.d.store.root))).not.toContain("FAKE-EXPLICIT-SECRET");
    const id = notices(f.d).notices[0]!.id;
    new MessengerJournal(f.d.store.root).reconcile(id, true, "platform-history-confirmed"); await again.tick();
    expect(f.sent()).toHaveLength(1); expect(notices(f.d).notices[0]!.externalReceipt).toBe("platform-history-confirmed");
  }
  finally { await again.stop(); }
});
test("runner recovers committed completion after outbox gap and lane-key reuse", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane, brief } = await allocate(f);
  await ready(f.d, lane.key, "first result", ["original-proof"], 1, lane.threadId); await done(f.d, lane.key, lane.threadId);
  writeFileSync(join(f.d.store.root, "notifications.json"), JSON.stringify({ notices: [], batches: [] }));
  await startLane(f.d, lane.key, brief, { cwd: f.d.store.root });
  try { await f.runner.tick(); expect(f.sent()).toHaveLength(1); expect(JSON.parse(String(f.sent()[0]!.body)).message_thread_id).toBe(7); expect(notices(f.d).notices[0]!.instance).toBe(lane.threadId); }
  finally { await f.runner.stop(); }
});
test("uncommitted notices cannot be sent by this runner", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f);
  expect(() => recordNotice(f.d, { task: lane.key, instance: lane.threadId, revision: 1, kind: "completion", summary: "forged", decision: "", details: [] })).toThrow("committed");
  try { await f.runner.tick(); expect(f.sent()).toHaveLength(0); }
  finally { await f.runner.stop(); }
});

test("stop is cooperative, closes sockets/timers, prevents further provider IO and admits no late events", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected();
  expect(f.timers.size).toBe(2); requestRunnerStop(f.d.store.root, f.runner.state.id);
  for (const t of [...f.timers.values()]) if (t.ms === 250) t.cb();
  const count = f.seen.length; await f.runner.stop();
  f.sockets[0]!.emit({ op: 0, s: 2, t: "MESSAGE_CREATE", d: { content: "late" } }); await f.runner.tick();
  expect(f.sockets[0]!.closed).toBe(true); expect(f.timers.size).toBe(0); expect(f.seen).toHaveLength(count); expect(runnerStatus(f.d.store.root)[0]!.state).toBe("stopped");
  const again = new MessengerRunner(f.d, f.config, f.io); try { await again.start(); expect(again.state.state).toBe("running"); } finally { await again.stop(); }
});
test("exclusive account lease and cursor identity reject concurrent service and changed owner/targets", async () => {
  const f = fixture(); expect(() => new MessengerRunner(f.d, f.config, f.io)).toThrow("already active"); await f.runner.stop();
  expect(() => new MessengerRunner(f.d, { ...f.config, ownerId: "3" }, f.io)).toThrow("differs");
  expect(() => new MessengerRunner(f.d, { ...f.config, targets: ["-21"] }, f.io)).toThrow("differs");
});

test("Slack paginates complete history oldest-first, commits cursor only after admission and watches roots", async () => {
  const f = fixture("slack"); await f.runner.start();
  f.override(r => {
    if (!r.url.endsWith("conversations.history")) return undefined;
    const b = JSON.parse(String(r.body));
    return ok({ ok: true, messages: b.cursor ? [{ ts: "100.000001", user: "2", text: "oldest" }] : [{ ts: "101.000001", user: "2", text: "newest" }], ...(b.cursor ? {} : { response_metadata: { next_cursor: "page2" }, has_more: true }) });
  });
  try {
    await f.runner.tick(); const requests = f.world.threads.get("work-lead")!.received.filter(t => t.includes("MESSENGER REQUEST")); expect(requests).toHaveLength(2); expect(requests[0]).toContain("oldest"); expect(requests[1]).toContain("newest"); expect(f.runner.state.slack["20"]).toBe("101.000001");
    expect(f.seen.some(r => r.url.endsWith("conversations.replies"))).toBe(true);
  } finally { await f.runner.stop(); }
});
test("Slack failed partial pagination keeps high watermark and does not admit partial snapshot", async () => {
  const f = fixture("slack"); await f.runner.start();
  f.override(r => { if (!r.url.endsWith("conversations.history")) return undefined; const b = JSON.parse(String(r.body)); if (b.cursor) throw new Error("network lost"); return ok({ ok: true, messages: [{ ts: "100.000001", user: "2", text: "pending" }], response_metadata: { next_cursor: "page2" }, has_more: true }); });
  try { await f.runner.tick(); expect(f.runner.state.slack["20"]).toBeUndefined(); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); }
  finally { await f.runner.stop(); }
});
test("Slack upstream discovery remains explicit and bot/subtype/quoted events never enter harness", async () => {
  const f = fixture("slack", { upstreamDiscovery: true }); await f.runner.start();
  f.slack.push({ ts: "100.000001", user: "2", text: "> quoted" }, { ts: "101.000001", user: "2", bot_id: "B", text: "bot" }, { ts: "102.000001", user: "2", subtype: "message_changed", text: "edit" }, { ts: "103.000001", user: "3", text: "guest" });
  try { await f.runner.tick(); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); expect(f.seen.some(r => r.url.endsWith("subscriptions.thread.getView"))).toBe(true); expect(f.seen.some(r => r.url.endsWith("client.counts"))).toBe(true); }
  finally { await f.runner.stop(); }
});

test("Discord persists admitted sequence/session, resumes after restart and deduplicates replay", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected(); await f.inbound(); const { lane } = await allocate(f); await f.inbound(2, "pivot"); await f.runner.stop();
  const again = new MessengerRunner(f.d, f.config, f.io);
  try {
    await again.start(); const s = f.sockets.at(-1)!; s.emit({ op: 10, d: { heartbeat_interval: 10_000 } }); await again.drained();
    expect(s.frames[0]).toMatchObject({ op: 6, d: { session_id: "session-fixture", seq: 3 } });
    s.emit({ op: 0, s: 3, t: "MESSAGE_CREATE", d: { id: "102", channel_id: "20", guild_id: "30", author: { id: "2" }, content: "pivot", type: 0 } }); await again.drained();
    expect(f.d.store.lane(lane.key)!.revision).toBe(2); expect(again.state.discord!.seq).toBe(3);
  } finally { await again.stop(); }
});
test("Discord heartbeat ACK watchdog reconnects with durable sequence and stops beating on shutdown", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected();
  const heartbeat = () => [...f.timers.values()].find(t => t.ms === 10_000)!.cb();
  heartbeat(); expect(f.sockets[0]!.frames.at(-1)).toEqual({ op: 1, d: 1 });
  heartbeat(); expect(f.sockets[0]!.closed).toBe(true); f.world.clock += 2000; await f.runner.tick(); expect(f.sockets).toHaveLength(2);
  await f.emit({ op: 10, d: { heartbeat_interval: 10_000 } }); expect(f.sockets[1]!.frames[0]!.op).toBe(6);
  await f.runner.stop(); expect(f.timers.size).toBe(0);
});
test("Discord invalid resume catches up history before identifying a replacement session", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected();
  await f.emit({ op: 9, d: false });
  expect(f.runner.state.issue).toContain("history-catchup-required"); expect(f.sockets[0]!.closed).toBe(true);
  f.discord.push({ id: "105", channel_id: "20", author: { id: "2" }, content: "missed during downtime", type: 0 });
  f.world.clock += 2000;
  try {
    await f.runner.tick(); expect(f.runner.state.discordAfter["20"]).toBe("105");
    expect(f.world.threads.get("work-lead")!.received.join("\n")).toContain("missed during downtime");
    await f.emit({ op: 10, d: { heartbeat_interval: 10_000 } }); expect(f.sockets[1]!.frames[0]!.op).toBe(2);
  } finally { await f.runner.stop(); }
});
test("Discord ignores malformed/guest/bot/other-guild events; malformed frames never advance sequence", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected();
  const base = { id: "101", channel_id: "20", guild_id: "30", author: { id: "2", bot: false }, content: "text", type: 0 };
  const patches = [{ author: { id: "3" } }, { author: { id: "2", bot: true } }, { guild_id: "99" }, { channel_id: "99" }, { message_snapshots: [{}] }, { content: "" }];
  try {
    for (const [i, patch] of patches.entries()) await f.emit({ op: 0, s: i + 2, t: "MESSAGE_CREATE", d: { ...base, ...patch } });
    expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); expect(f.runner.state.discord!.seq).toBe(7);
    f.sockets[0]!.message("invalid JSON FAKE-EXPLICIT-SECRET"); await f.runner.drained();
    expect(f.runner.state.discord!.seq).toBe(7); expect(f.runner.state.issue).not.toContain("FAKE-EXPLICIT-SECRET");
  } finally { await f.runner.stop(); }
});

test("stop aborts an in-flight write, retains uncertainty and sends no later provider request", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f);
  await ready(f.d, lane.key, "result", ["fixture"], 1, lane.threadId); await done(f.d, lane.key, lane.threadId);
  let entered!: () => void; const called = new Promise<void>(r => entered = r);
  f.override(r => r.url.endsWith("sendMessage") ? new Promise((_resolve, reject) => { entered(); r.signal!.addEventListener("abort", () => reject(new Error("write outcome unknown")), { once: true }); }) : undefined);
  const tick = f.runner.tick(); await called; const count = f.seen.length;
  f.runner.requestStop(); await tick; await f.runner.stop();
  expect(f.seen).toHaveLength(count); expect(new MessengerJournal(f.d.store.root).outgoing()[0]!.state).toBe("uncertain");
});

test("one account cannot dispatch a different account's committed completion", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f);
  await ready(f.d, lane.key, "private result", ["fixture"], 1, lane.threadId); await done(f.d, lane.key, lane.threadId); await f.runner.stop();
  f.override(r => r.url.endsWith("getMe") ? ok({ ok: true, result: { id: 8, is_bot: true } }) : undefined);
  const other = new MessengerRunner(f.d, { ...f.config, account: "8" }, f.io);
  try { await other.start(); await other.tick(); expect(f.sent()).toHaveLength(0); expect(notices(f.d).notices[0]!.externalReceipt).toBeUndefined(); }
  finally { await other.stop(); }
});

test("committed outbound delivery proceeds despite an unavailable inbound endpoint", async () => {
  const f = fixture(); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f);
  await ready(f.d, lane.key, "result", ["fixture"], 1, lane.threadId); await done(f.d, lane.key, lane.threadId);
  f.override(r => { if (r.url.endsWith("getUpdates")) throw new Error("inbound unavailable"); return undefined; });
  try { await f.runner.tick(); expect(f.sent()).toHaveLength(1); expect(f.runner.state.issue).toBe("cycle-unconfirmed"); }
  finally { await f.runner.stop(); }
});

test("Slack durable channel and watched-thread cursors survive restart", async () => {
  const f = fixture("slack"); await f.runner.start(); await f.inbound(); const { lane } = await allocate(f); await f.inbound(2, "pivot"); await f.runner.stop();
  const count = f.world.threads.get(lane.threadId)!.received.length;
  const again = new MessengerRunner(f.d, f.config, f.io);
  try { await again.start(); await again.tick(); expect(f.d.store.lane(lane.key)!.revision).toBe(2); expect(f.world.threads.get(lane.threadId)!.received).toHaveLength(count); expect(again.state.slack["20"]).toBe("100.000001"); }
  finally { await again.stop(); }
});

test("Slack discovery hints cannot launder a changed/forwarded raw event into an owner request", async () => {
  const f = fixture("slack", { upstreamDiscovery: true }); await f.runner.start();
  f.override(r => r.url.endsWith("subscriptions.thread.getView") ? ok({ ok: true, threads: [{ root_msg: { channel: "20", ts: "100.000001" }, unread_replies: [{ user: "2", ts: "101.000001", text: "projection omits subtype" }] }] }) : undefined);
  f.slack.push({ ts: "101.000001", thread_ts: "100.000001", user: "2", text: "projection omits subtype", subtype: "message_changed" });
  try { await f.runner.tick(); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); expect(f.seen.some(r => r.url.endsWith("conversations.replies"))).toBe(true); }
  finally { await f.runner.stop(); }
});

test("Discord REST snapshot commits after all pages and deduplicates gateway admission", async () => {
  const f = fixture("discord"); await f.runner.start(); await f.connected(); await f.inbound();
  f.discord.push({ id: "101", channel_id: "20", author: { id: "2" }, content: "Implement owner request", type: 0 });
  try { await f.runner.tick(); expect(f.runner.state.discordAfter["20"]).toBe("101"); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(1); }
  finally { await f.runner.stop(); }
});

test("Discord partial history failure retains cursor and all unadmitted events", async () => {
  const f = fixture("discord"); await f.runner.start();
  f.override(r => {
    if (!r.url.includes("/messages?")) return undefined;
    if (r.url.includes("before=")) throw new Error("history page unavailable");
    return ok(Array.from({ length: 100 }, (_, i) => ({ id: String(i + 100), channel_id: "20", author: { id: "2" }, content: "pending", type: 0 })).reverse());
  });
  try { await f.runner.tick(); expect(f.runner.state.discordAfter["20"]).toBe("0"); expect(new MessengerJournal(f.d.store.root).inbound()).toHaveLength(0); }
  finally { await f.runner.stop(); }
});

test("foreground service automatically receives, pivots and replies without per-message admission/tick API calls", async () => {
  const f = fixture("telegram", { intervalMs: 250 });
  let phase = 0, lane: Awaited<ReturnType<typeof allocate>>["lane"] | undefined;
  f.io.clock.sleep = async ms => {
    f.world.clock += ms; phase++;
    const event = (id: number, text: string) => ({ update_id: id, message: { message_id: id + 10, chat: { id: -20 }, message_thread_id: 7, from: { id: 2, is_bot: false }, text } });
    if (phase === 1) f.telegram.push(event(1, "initial request"));
    if (phase === 2) { lane = (await allocate(f)).lane; f.telegram.push(event(2, "follow-up")); }
    if (phase === 3) {
      expect(f.d.store.lane(lane!.key)!.revision).toBe(2);
      acknowledge(f.d, lane!.key, 2, lane!.threadId); await ready(f.d, lane!.key, "automatic result", ["fixture"], 2, lane!.threadId); await done(f.d, lane!.key, lane!.threadId);
    }
    if (phase === 4) { expect(f.sent()).toHaveLength(1); f.runner.requestStop(); }
    if (phase > 4) throw new Error("service failed to stop");
  };
  await f.runner.run(); expect(f.runner.state.state).toBe("stopped"); expect(f.timers.size).toBe(0); expect(f.world.threads.get("conversation")!.received).toHaveLength(0);
});

test("corrupt durable cursors fail before provider IO rather than resetting or issuing a negative Telegram offset", async () => {
  const f = fixture(); await f.runner.stop();
  const file = join(f.d.store.root, "messenger", "runners", `${f.runner.state.id}.json`), state = JSON.parse(readFileSync(file, "utf8")); state.telegramOffset = -1; writeFileSync(file, JSON.stringify(state));
  expect(() => new MessengerRunner(f.d, f.config, f.io)).toThrow("invalid durable"); expect(f.seen).toHaveLength(0);
});
