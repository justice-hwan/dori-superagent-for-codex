import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Discord, discordPresence, Slack, slackPresence, Telegram, THINKING, startThinking, htmlTable, typingWhile, transcribe, TranscriptionError, MessengerError, MessengerUncertain, UnsafeMessageError, MessengerJournal, sendMessenger, ThreadLedger, pollSlackInbound, tsAfter, type Http, type HttpRequest, type HttpResponse, type MessengerOrigin } from "../src/messenger.ts";
const fakeClock = (at: number) => ({ at, now() { return this.at; }, async sleep(ms: number) { this.at += ms; } });
const roots: string[] = [];
const temporary = () => { const path = mkdtempSync(join(tmpdir(), "dori-messenger-")); roots.push(path); return path; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });


type Script = (req: HttpRequest, n: number) => HttpResponse;
const fakeHttp = (script: Script) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, body: JSON.stringify(body) });
const sleeps = () => {
  const waited: number[] = [];
  const clock = { ...fakeClock(0), sleep: async (ms: number) => { waited.push(ms); } };
  return { clock, waited };
};
const fakeTimers = () => {
  const live = new Set<() => void>();
  return {
    live,
    timers: { setInterval: (cb: () => void) => { live.add(cb); return cb; }, clearInterval: (h: unknown) => { live.delete(h as () => void); } },
    fire: () => { for (const cb of live) cb(); },
  };
};

test("a Slack post that hits the rate limit waits retry-after seconds, retries, and lands in the thread", async () => {
  const { http, seen } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error: "ratelimited" }, 429, { "retry-after": "3" }) : ok({ ok: true, channel: "C1", ts: "111.222" })));
  const { clock, waited } = sleeps();
  const posted = await new Slack(http, clock, { token: "t" }).post("C1", "deploy finished", "100.1");
  expect(posted).toEqual({ channel: "C1", ts: "111.222" });
  expect(waited).toEqual([3000]);
  expect(JSON.parse(String(seen[1]?.body))).toEqual({ channel: "C1", text: "deploy finished", thread_ts: "100.1" });
});

test("a Slack error that is not transient fails at once with the API error, without retries", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: false, error: "channel_not_found" }));
  const err = await new Slack(http, sleeps().clock, { token: "t" }).edit("C9", "1.2", "x").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MessengerError);
  expect((err as MessengerError).code).toBe("channel_not_found");
  expect(seen).toHaveLength(1);
});

test("text carrying a $( substitution is refused before any request goes out, on every platform", async () => {
  const { http, seen } = fakeHttp(() => ok({ ok: true }));
  const clock = sleeps().clock;
  await expect(new Slack(http, clock, { token: "t" }).post("C1", "result: $(whoami)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Telegram(http, clock, "b").send({ chatId: 1 }, "$(id)")).rejects.toBeInstanceOf(UnsafeMessageError);
  await expect(new Discord(http, clock, "b").send("9", "x $(ls)")).rejects.toBeInstanceOf(UnsafeMessageError);
  expect(seen).toHaveLength(0);
});

test("a Slack upload asks for an upload URL, sends the bytes there, then shares the file into the thread", async () => {
  const { http, seen } = fakeHttp((req) => {
    if (req.url.endsWith("files.getUploadURLExternal")) return ok({ ok: true, upload_url: "https://files.example/up/1", file_id: "F1" });
    if (req.url.startsWith("https://files.example")) return { status: 200, headers: {}, body: "OK" };
    return ok({ ok: true });
  });
  const id = await new Slack(http, sleeps().clock, { token: "t" }).upload("C1", "report.png", new Uint8Array([1, 2, 3]), "5.6");
  expect(id).toBe("F1");
  expect(seen.map((r) => r.url.split("/").pop())).toEqual(["files.getUploadURLExternal", "1", "files.completeUploadExternal"]);
  expect(JSON.parse(String(seen[2]?.body))).toMatchObject({ channel_id: "C1", thread_ts: "5.6" });
});

test("a Telegram reply starts as Thinking…, streams drafts no faster than the interval, then persists as a real message", async () => {
  const { http, seen } = fakeHttp((req) => ok({ ok: true, result: req.url.endsWith("sendMessage") ? { message_id: 77 } : true }));
  const clock = fakeClock(10_000);
  const tg = new Telegram(http, clock, "b");
  const s = await startThinking(tg, clock, { chatId: 5, threadId: 9 });
  clock.at += 100;
  await s.push("Half");
  clock.at += 900;
  await s.push("Half done");
  const id = await s.finish("All done");
  const calls = seen.map((r) => [r.url.split("/").pop(), JSON.parse(String(r.body)).text]);
  expect(calls).toEqual([["sendMessageDraft", THINKING], ["sendMessageDraft", "Half done"], ["sendMessage", "All done"]]);
  expect(id).toBe(77);
  expect(JSON.parse(String(seen[0]?.body)).message_thread_id).toBe(9);
});

test("Telegram's retry_after in the error body is honored", async () => {
  const { http } = fakeHttp((_, n) => (n === 1 ? ok({ ok: false, error_code: 429, parameters: { retry_after: 7 } }, 429) : ok({ ok: true, result: { message_id: 1 } })));
  const { clock, waited } = sleeps();
  await new Telegram(http, clock, "b").send({ chatId: 1 }, "hi");
  expect(waited).toEqual([7000]);
});

test("a rich Telegram table escapes HTML and lines columns up inside one pre block", () => {
  expect(htmlTable(["name", "n"], [["a<b", "10"], ["c", "2"]])).toBe("<pre>name  n \n----  --\na&lt;b   10\nc     2 </pre>");
});

test("Discord messages are sent without pinging anyone and edited in place; threads are named and archived", async () => {
  const { http, seen } = fakeHttp((req) => ok(req.method === "POST" && req.url.endsWith("/messages") ? { id: "M1" } : { id: "T1" }));
  const dc = new Discord(http, sleeps().clock, "b");
  expect(await dc.send("C1", "hello @everyone")).toBe("M1");
  await dc.edit("C1", "M1", "hello again");
  expect(await dc.startThread("C1", "M1", "[working] fix login")).toBe("T1");
  await dc.setThread("T1", { name: "[done] fix login", archived: true });
  expect(JSON.parse(String(seen[0]?.body)).allowed_mentions).toEqual({ parse: [] });
  expect(seen.map((r) => `${r.method} ${r.url.replace("https://discord.com/api/v10", "")}`)).toEqual(["POST /channels/C1/messages", "PATCH /channels/C1/messages/M1", "POST /channels/C1/messages/M1/threads", "PATCH /channels/T1"]);
});

test("the typing indicator is sent at once, repeats while work runs, and stops when it ends even on failure", async () => {
  const sent: number[] = [];
  const t = fakeTimers();
  const send = async () => { sent.push(1); };
  const result = await typingWhile(send, t.timers, async () => { t.fire(); t.fire(); return 42; });
  expect(result).toBe(42);
  expect(sent).toHaveLength(3);
  expect(t.live.size).toBe(0);
  await expect(typingWhile(send, t.timers, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(t.live.size).toBe(0);
});

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "  ship it  ", err: "" }; };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});

test("Slack presence opens one client-type socket with the cookie, then only tickles it; release closes it and sets away", async () => {
  const { http, seen } = fakeHttp((req) => (req.url.endsWith("client.getWebSocketURL") ? ok({ ok: true, primary_websocket_url: "wss://wss-primary.example/", routing_context: "gw-1" }) : ok({ ok: true })));
  const frames: string[] = [];
  let opened: { url: string; headers: Record<string, string> } | null = null;
  let open = false;
  const p = slackPresence(new Slack(http, sleeps().clock, { token: "xt", cookie: "dc" }), (url, headers) => {
    opened = { url, headers: { ...headers } };
    open = true;
    return { isOpen: () => open, send: (f) => frames.push(f), close: () => { open = false; } };
  }, { token: "xt", cookie: "dc" });
  expect(await p.hold()).toBe("opened");
  expect(await p.hold()).toBe("tickled");
  expect(await p.hold()).toBe("tickled");
  const url = new URL(opened!.url);
  expect(url.searchParams.get("slack_client")).toBe("desktop");
  expect(url.searchParams.get("gateway_server")).toBe("gw-1");
  expect(opened!.headers).toEqual({ Cookie: "d=dc", Origin: "https://app.slack.com" });
  expect(frames.map((f) => JSON.parse(f).type)).toEqual(["tickle", "tickle"]);
  await p.release();
  expect(open).toBe(false);
  expect(seen.filter((r) => r.url.endsWith("users.setPresence")).map((r) => JSON.parse(String(r.body)).presence)).toEqual(["auto", "away"]);
});

test("Discord presence identifies as online after hello, heartbeats with the last sequence, and stops beating on close", () => {
  const sent: string[] = [];
  let onMsg: (d: string) => void = () => {};
  const t = fakeTimers();
  let closed = false;
  const p = discordPresence(() => ({ send: (d) => sent.push(d), close: () => { closed = true; }, onMessage: (cb) => { onMsg = cb; } }), "BOT", t.timers);
  onMsg(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
  onMsg(JSON.stringify({ op: 0, s: 3, t: "READY", d: {} }));
  t.fire();
  const identify = JSON.parse(sent[0] ?? "{}");
  expect(identify.op).toBe(2);
  expect(identify.d.presence.status).toBe("online");
  expect(JSON.parse(sent[1] ?? "{}")).toEqual({ op: 1, d: 3 });
  p.close();
  expect(closed).toBe(true);
  expect(t.live.size).toBe(0);
});

const origin: MessengerOrigin = { platform: "slack", target: "C1", thread: "100.001", account: "workspace-1" };
test("optional messenger is off until explicitly enabled and does not read credentials", async () => {
  let requests = 0; const http: Http = async () => { requests++; throw new Error("network forbidden"); };
  await expect(sendMessenger({ enabled: false, platform: "slack", credential: "not-used", target: "C1", text: "hello" }, http)).rejects.toThrow("disabled");
  expect(requests).toBe(0);
});
test("send helper preserves original Slack thread, Telegram forum and Discord thread routes", async () => {
  const seen: HttpRequest[] = [];
  const http: Http = async req => { seen.push(req); return ok(req.url.includes("telegram") ? { ok: true, result: { message_id: 9 } } : req.url.includes("slack") ? { ok: true, channel: "C1", ts: "1.2" } : { id: "D9" }); };
  expect((await sendMessenger({ enabled: true, platform: "slack", credential: "fake", target: "C1", thread: "1.1", text: "hi" }, http)).messageId).toBe("1.2");
  expect((await sendMessenger({ enabled: true, platform: "telegram", credential: "fake", target: "-123", thread: "7", text: "hi" }, http)).messageId).toBe("9");
  expect((await sendMessenger({ enabled: true, platform: "discord", credential: "fake", target: "C1", thread: "T1", text: "hi" }, http)).messageId).toBe("D9");
  expect(JSON.parse(String(seen[0]!.body)).thread_ts).toBe("1.1"); expect(JSON.parse(String(seen[1]!.body)).message_thread_id).toBe(7); expect(seen[2]!.url).toEndWith("/channels/T1/messages");
});
test("persistent receipts deduplicate exact retry across restart and reject altered origin/content", async () => {
  const home = temporary(), journal = new MessengerJournal(home); let sends = 0;
  const first = await journal.deliver("completion-1", origin, "done", async () => { sends++; return { messageId: "123.456" }; });
  expect(first.state).toBe("sent");
  expect((await new MessengerJournal(home).deliver("completion-1", origin, "done", async () => { sends++; return { messageId: "other" }; })).messageId).toBe("123.456");
  await expect(journal.deliver("completion-1", { ...origin, thread: "wrong" }, "done", async () => ({ messageId: "bad" }))).rejects.toThrow("conflicts");
  await expect(journal.deliver("completion-1", origin, "changed", async () => ({ messageId: "bad" }))).rejects.toThrow("conflicts"); expect(sends).toBe(1);
});
test("lost platform response is durable uncertainty and is never blindly replayed or logged", async () => {
  const home = temporary(), journal = new MessengerJournal(home); let sends = 0;
  await expect(journal.deliver("lost", origin, "done", async () => { sends++; throw new Error("https://api.telegram.org/botPRIVATE-TOKEN/sendMessage"); })).rejects.toBeInstanceOf(MessengerUncertain);
  await expect(new MessengerJournal(home).deliver("lost", origin, "done", async () => { sends++; return { messageId: "duplicate" }; })).rejects.toBeInstanceOf(MessengerUncertain);
  const saved = readFileSync(join(home, "messenger/journal.json"), "utf8"); expect(saved).not.toContain("PRIVATE-TOKEN"); expect(sends).toBe(1);
  journal.reconcile("lost", true, "original-platform-message"); expect(journal.outgoing()[0]?.state).toBe("sent");
});
test("a crash before receipt leaves sending intent unresolved, even across restart", async () => {
  const home = temporary(), journal = new MessengerJournal(home);
  await journal.deliver("crash", origin, "x", async () => ({ messageId: "original" }));
  const path = join(home, "messenger/journal.json"), state = JSON.parse(readFileSync(path, "utf8"));
  Object.values<any>(state.outgoing)[0]!.state = "sending"; writeFileSync(path, JSON.stringify(state)); let replayed = false;
  await expect(new MessengerJournal(home).deliver("crash", origin, "x", async () => { replayed = true; return { messageId: "bad" }; })).rejects.toBeInstanceOf(MessengerUncertain); expect(replayed).toBe(false);
});
test("concurrent identical deliveries admit one sender", async () => {
  const journal = new MessengerJournal(temporary()); let release!: () => void, sends = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = journal.deliver("race", origin, "x", async () => { sends++; await gate; return { messageId: "one" }; });
  await expect(journal.deliver("race", origin, "x", async () => { sends++; return { messageId: "two" }; })).rejects.toThrow("in progress"); release(); await first; expect(sends).toBe(1);
});
test("task origin is immutable and replies follow its original channel/thread", async () => {
  const journal = new MessengerJournal(temporary()); journal.bindTask("login-task", origin); journal.bindTask("login-task", origin);
  expect(() => journal.bindTask("login-task", { ...origin, target: "another" })).toThrow("already bound");
  let used: MessengerOrigin | undefined; await journal.reply("login-task", "answer", "done", async route => { used = route; return { messageId: "reply" }; }); expect(used).toEqual(origin);
});
test("only authenticated owner requests enter bound task and duplicate events stay idempotent", async () => {
  const journal = new MessengerJournal(temporary()); journal.bindTask("login-task", origin);
  const event = { id: "event-1", authorId: "OWNER", origin, text: "change login" }, opts = { ownerId: "OWNER", verify: async () => true, task: "login-task" };
  expect((await journal.acceptInbound(event, opts)).duplicate).toBe(false); expect((await journal.acceptInbound(event, opts)).duplicate).toBe(true);
  await expect(journal.acceptInbound({ ...event, text: "different" }, opts)).rejects.toThrow("conflicts");
  for (const patch of [{ authorId: "GUEST" }, { forwarded: true }, { quoted: true }]) await expect(journal.acceptInbound({ ...event, ...patch }, opts)).rejects.toThrow("not a verified owner");
  await expect(journal.acceptInbound(event, { ...opts, verify: async () => false })).rejects.toThrow("not a verified owner");
  await expect(journal.acceptInbound({ ...event, id: "other", origin: { ...origin, thread: "different" } }, opts)).rejects.toThrow("does not match");
  expect(journal.inbound()).toHaveLength(1); journal.markInboundHandled("slack", origin.account, event.id); expect(journal.inbound()[0]?.handledAt).toBeNumber();
});
test("uncertain server errors are not retried and raw errors never reveal credentials", async () => {
  let requests = 0, waits = 0; const http: Http = async () => { requests++; return { status: 503, headers: {}, body: "PRIVATE-TOKEN" }; };
  const clock = { now: () => 0, sleep: async () => { waits++; } };
  const err = await new Discord(http, clock, "PRIVATE-TOKEN").send("C1", "hi").catch(e => e);
  expect(String(err)).not.toContain("PRIVATE-TOKEN"); expect(requests).toBe(1); expect(waits).toBe(0);
  const tgError = await new Telegram(async () => { throw new Error("PRIVATE-TOKEN"); }, clock, "PRIVATE-TOKEN").send({ chatId: 1 }, "hi").catch(e => e); expect(String(tgError)).not.toContain("PRIVATE-TOKEN");
});
test("Slack watched-thread polling preserves replies until caller commits its cursor", async () => {
  const home = temporary(), ledger = new ThreadLedger(join(home, "threads.json"));
  const { http } = fakeHttp(req => {
    const method = req.url.split("/").pop();
    if (method === "chat.postMessage") return ok({ ok: true, channel: "C1", ts: "100.000001" });
    if (method === "subscriptions.thread.getView") return ok({ ok: true, threads: [] });
    if (method === "conversations.replies") { const body = JSON.parse(String(req.body)); return ok({ ok: true, messages: body.oldest === "100.000001" ? [{ ts: "101.000002", user: "OWNER", text: "pivot" }] : [] }); }
    return ok({ ok: true, channels: [], ims: [], mpims: [] });
  });
  const slack = new Slack(http, fakeClock(0), { token: "fake" }, undefined, ledger); await slack.post("C1", "starting");
  const first = await pollSlackInbound(slack, ledger, { selfUserId: "SELF" }); expect(first[0]?.text).toBe("pivot");
  expect(await pollSlackInbound(slack, new ThreadLedger(join(home, "threads.json")), { selfUserId: "SELF" })).toEqual(first);
  await ledger.markSeen("C1", "100.000001", "101.000002"); expect(await pollSlackInbound(slack, ledger, { selfUserId: "SELF" })).toEqual([]);
  expect(tsAfter("9999999999.000002", "9999999999.000001")).toBe(true);
});
test("origin scopes include account, workspace and original message and accept unique native task instances", async () => {
  const journal = new MessengerJournal(temporary()), id = "01a1a01e-4d8a-7410-b292-be5b9eb9e098";
  const scoped = { ...origin, workspace: "W1", sourceMessage: "1.2" }; journal.bindTask(id, scoped);
  for (const patch of [{ account: "other" }, { workspace: "W2" }, { sourceMessage: "2.3" }]) expect(() => journal.bindTask(id, { ...scoped, ...patch })).toThrow("already bound");
  expect(() => journal.bindTask("another-instance", { platform: "slack", target: "C1" })).toThrow("explicit account");
  const path = join(temporary(), "threads.json"), a = new ThreadLedger(path, { account: "A", workspace: "W" }), b = new ThreadLedger(path, { account: "B", workspace: "W" });
  await a.record("C1", "1.1", "2.2"); expect(await b.list()).toEqual([]); await b.record("C1", "1.1", "3.3"); expect((await a.list())[0]?.seenTs).toBe("2.2");
});
test("HTTP200 internal errors are uncertain and unsupported arbitrary error prose is never exposed", async () => {
  const http: Http = async () => ok({ ok: false, error: "PRIVATE-TOKEN / secret error prose" });
  const error = await new Slack(http, fakeClock(0), { token: "PRIVATE-TOKEN" }).post("C1", "hi").catch(e => e); expect(error).toBeInstanceOf(MessengerUncertain); expect(String(error)).not.toContain("PRIVATE-TOKEN");
});
test("inbound verification freezes routing and does not persist unrelated credential fields", async () => {
  const home = temporary(), journal = new MessengerJournal(home); journal.bindTask("task-instance", origin);
  const raw = { id: "freeze", authorId: "OWNER", origin, text: "pivot", credential: "DO-NOT-SAVE" };
  await journal.acceptInbound(raw, { ownerId: "OWNER", task: "task-instance", verify: async envelope => { expect(Object.isFrozen(envelope)).toBe(true); expect(Object.isFrozen(envelope.origin)).toBe(true); return true; } });
  expect(readFileSync(join(home, "messenger/journal.json"), "utf8")).not.toContain("DO-NOT-SAVE");
  const error = await journal.acceptInbound({ ...raw, id: "bad-verifier" }, { ownerId: "OWNER", verify: async () => { throw new Error("DO-NOT-PRINT"); } }).catch(e => e); expect(String(error)).not.toContain("DO-NOT-PRINT");
});
test("a new owner follow-up source message is accepted on the bound route while original reply origin is retained", async () => {
  const journal = new MessengerJournal(temporary()), bound = { ...origin, workspace: "W1", sourceMessage: "initial-owner-message" }; journal.bindTask("task-instance", bound);
  const followup = { id: "followup", authorId: "OWNER", origin: { ...bound, sourceMessage: "new-owner-message" }, text: "pivot again" };
  expect((await journal.acceptInbound(followup, { ownerId: "OWNER", verify: async () => true, task: "task-instance" })).duplicate).toBe(false);
  expect(journal.origin("task-instance")?.sourceMessage).toBe("initial-owner-message");
  for (const patch of [{ account: "other" }, { workspace: "other" }, { target: "other" }, { thread: "other" }]) await expect(journal.acceptInbound({ ...followup, id: "other-event", origin: { ...followup.origin, ...patch } }, { ownerId: "OWNER", verify: async () => true, task: "task-instance" })).rejects.toThrow("does not match");
});
