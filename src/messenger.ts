// Messenger primitives adapted from sisyphuslabs/dori-superagent (MIT),
// upstream 90f02c19fd86ce70cfd6a74f521c9acd24428cc3, skills/dori-mode/scripts/src/messenger/.
// Importing this module starts no connection and reads no credentials.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLease } from "./lock.ts";
export type Clock = { now(): number; sleep(ms: number): Promise<void> };
export const realClock: Clock = { now: Date.now, sleep: ms => Bun.sleep(ms) };


export type HttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | FormData | Uint8Array<ArrayBuffer>;
};
export type HttpResponse = { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string };
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(30_000), redirect: "error" });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, body: await res.text() };
};

export class MessengerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class UnsafeMessageError extends Error {}

export const guardText = (text: string): string => {
  if (text.includes("$(")) throw new UnsafeMessageError("message text contains $( ; build messages as data, never through a shell string");
  return text;
};

export type RetryPolicy = { readonly attempts: number; readonly baseMs: number; readonly maxMs: number };
export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1_000, maxMs: 60_000 };

export const withBackoff = async (http: Http, clock: Clock, req: HttpRequest, policy: RetryPolicy = DEFAULT_RETRY, retryAfterFromBody?: (body: string) => number | undefined): Promise<HttpResponse> => {
  let last: HttpResponse | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try { last = await http(req); } catch { throw new MessengerUncertain(); }
    // Rate-limit refusals are retryable. A 5xx may have committed a write.
    if (last.status !== 429) return last;
    const header = Number(last.headers["retry-after"]);
    const fromBody = retryAfterFromBody?.(last.body);
    const waitS = Number.isFinite(header) && header > 0 ? header : fromBody;
    const waitMs = waitS !== undefined ? waitS * 1000 : Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
    if (attempt < policy.attempts - 1) await clock.sleep(Math.min(policy.maxMs, waitMs));
  }
  return last as HttpResponse;
};


export type TgTarget = { readonly chatId: number | string; readonly threadId?: number };

const telegramRetryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Telegram {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://api.telegram.org",
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${this.base}/bot${this.botToken}/${method}`, headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }, undefined, telegramRetryAfter);
    const body = parseBody(res.body) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!body.ok) throw new MessengerError(`telegram ${method} rejected`, body.error_code ?? res.status);
    return body.result as T;
  }

  private where(t: TgTarget): Record<string, unknown> {
    return { chat_id: t.chatId, ...(t.threadId ? { message_thread_id: t.threadId } : {}) };
  }

  async send(t: TgTarget, text: string, rich = false): Promise<number> {
    const r = await this.call<{ message_id: number }>("sendMessage", { ...this.where(t), text: guardText(text), ...(rich ? { parse_mode: "HTML" } : {}) });
    return r.message_id;
  }

  async edit(t: TgTarget, messageId: number, text: string, rich = false): Promise<void> {
    await this.call("editMessageText", { chat_id: t.chatId, message_id: messageId, text: guardText(text), ...(rich ? { parse_mode: "HTML" } : {}) });
  }

  async typing(t: TgTarget): Promise<void> {
    await this.call("sendChatAction", { ...this.where(t), action: "typing" });
  }

  async draft(t: TgTarget, draftId: number, text: string): Promise<void> {
    await this.call("sendMessageDraft", { ...this.where(t), draft_id: draftId, text: guardText(text) });
  }

  async createTopic(chatId: number | string, name: string): Promise<number> {
    const r = await this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: chatId, name: guardText(name).slice(0, 128) });
    return r.message_thread_id;
  }

  async renameTopic(chatId: number | string, threadId: number, name: string): Promise<void> {
    await this.call("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name: guardText(name).slice(0, 128) });
  }

  async closeTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  async reopenTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }
}

export const THINKING = "Thinking…";

export type DraftStream = { push(text: string): Promise<void>; finish(text: string, rich?: boolean): Promise<number> };

export const streamDraft = (tg: Telegram, clock: Clock, t: TgTarget, minIntervalMs = 800): DraftStream => {
  const draftId = Math.max(1, clock.now() % 2_000_000_000);
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending = "";
  let shown = "";
  const flush = async () => {
    if (pending === shown) return;
    await tg.draft(t, draftId, pending);
    shown = pending;
    lastAt = clock.now();
  };
  return {
    async push(text) {
      pending = text || THINKING;
      if (clock.now() - lastAt >= minIntervalMs) await flush();
    },
    async finish(text, rich = false) {
      return tg.send(t, text, rich);
    },
  };
};

export const startThinking = async (tg: Telegram, clock: Clock, t: TgTarget): Promise<DraftStream> => {
  const s = streamDraft(tg, clock, t);
  await s.push(THINKING);
  return s;
};

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const htmlTable = (head: readonly string[], rows: readonly (readonly string[])[]): string => {
  const cells = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]) => r.map((c, i) => escapeHtml(c.padEnd(widths[i] ?? 0))).join("  ");
  return `<pre>${[line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n")}</pre>`;
};


const discordRetryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await withBackoff(this.http, this.clock, { method, url: `${this.base}${path}`, headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }, undefined, discordRetryAfter);
    if (res.status >= 300) throw new MessengerError(`discord request rejected (${res.status})`, res.status);
    return (res.body ? parseBody(res.body) : {}) as T;
  }

  async send(channelId: string, content: string): Promise<string> {
    return (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, { content: guardText(content), allowed_mentions: { parse: [] } })).id;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guardText(content), allowed_mentions: { parse: [] } });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, { name: guardText(name).slice(0, 100) })).id;
  }

  async setThread(threadId: string, patch: { readonly name?: string; readonly archived?: boolean }): Promise<void> {
    await this.call("PATCH", `/channels/${threadId}`, { ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}) });
  }
}

export type GatewaySocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void };

export const DISCORD_INTENTS_GUILD_MESSAGES = 1 << 9;

export const discordPresence = (open: () => GatewaySocket, token: string, clock: { setInterval: (cb: () => void, ms: number) => unknown; clearInterval: (h: unknown) => void }) => {
  const ws = open();
  let seq: number | null = null;
  let beat: unknown;
  ws.onMessage((raw) => {
    const m = JSON.parse(raw) as { op: number; s?: number | null; d?: { heartbeat_interval?: number } };
    if (typeof m.s === "number") seq = m.s;
    if (m.op === 10 && m.d?.heartbeat_interval) {
      beat = clock.setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token, intents: DISCORD_INTENTS_GUILD_MESSAGES, properties: { os: process.platform, browser: "dori", device: "dori" }, presence: { status: "online", since: null, activities: [], afk: false } } }));
    }
  });
  return {
    close() {
      if (beat !== undefined) clock.clearInterval(beat);
      ws.close();
    },
  };
};


export type SlackAuth = { readonly token: string; readonly cookie?: string };
export type Posted = { readonly channel: string; readonly ts: string };

export class Slack {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly auth: SlackAuth,
    private readonly base = "https://slack.com/api",
    private readonly ledger?: ThreadLedger,
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.auth.token}`,
      ...(json ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(this.auth.cookie ? { Cookie: `d=${this.auth.cookie}` } : {}),
    };
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await withBackoff(this.http, this.clock, { method: "POST", url: `${this.base}/${method}`, headers: this.headers(true), body: JSON.stringify(params) });
    const body = parseBody(res.body) as Record<string, unknown>;
    if (res.status !== 200 || body.ok !== true) {
      if (res.status >= 500 || (res.status === 200 && !["not_authed", "invalid_auth", "account_inactive", "token_revoked", "not_in_channel", "channel_not_found", "is_archived", "msg_too_long", "missing_scope", "restricted_action", "invalid_arguments", "invalid_arg_name", "ratelimited", "method_not_supported_for_channel_type", "cant_update_message", "message_not_found", "not_allowed_token_type"].includes(String(body.error)))) throw new MessengerUncertain();
      throw new MessengerError(`slack ${method} rejected`, res.status, typeof body.error === "string" && /^[a-z_]{1,80}$/.test(body.error) ? body.error : undefined);
    }
    if (this.ledger && method === "chat.postMessage" && typeof body.ts === "string") {
      const channel = String(body.channel ?? params.channel);
      await this.ledger.record(channel, typeof params.thread_ts === "string" ? params.thread_ts : body.ts, body.ts);
    }
    return body;
  }

  async post(channel: string, text: string, threadTs?: string): Promise<Posted> {
    const r = await this.call("chat.postMessage", { channel, text: guardText(text), ...(threadTs ? { thread_ts: threadTs } : {}) });
    return { channel: String(r.channel), ts: String(r.ts) };
  }

  async edit(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel, ts, text: guardText(text) });
  }

  async upload(channel: string, filename: string, bytes: Uint8Array<ArrayBuffer>, threadTs?: string, title?: string): Promise<string> {
    const slot = await this.call("files.getUploadURLExternal", { filename, length: bytes.byteLength });
    const put = await withBackoff(this.http, this.clock, { method: "POST", url: String(slot.upload_url), body: bytes });
    if (put.status !== 200) throw new MessengerError(`slack upload: ${put.status}`, put.status);
    await this.call("files.completeUploadExternal", { files: [{ id: slot.file_id, title: title ?? filename }], channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}) });
    return String(slot.file_id);
  }

  async setPresence(presence: "auto" | "away"): Promise<void> {
    await this.call("users.setPresence", { presence });
  }
}

export type Timers = { readonly setInterval: (cb: () => void, ms: number) => unknown; readonly clearInterval: (h: unknown) => void };

export const realTimers: Timers = { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };

export const typingWhile = async <T>(send: () => Promise<void>, timers: Timers, work: () => Promise<T>, everyMs = 4_000): Promise<T> => {
  await send().catch(() => {});
  const h = timers.setInterval(() => void send().catch(() => {}), everyMs);
  try {
    return await work();
  } finally {
    timers.clearInterval(h);
  }
};

// Slack shows a user-token account as active only while a web-client-type socket is open: rtm.connect sockets are typed
// as bot connections and never count. One such socket stays green; an idle one is auto-awayed after ~30 min, so a
// tickle frame every minute keeps it active. Never answer a manual_presence_change event with setPresence: two
// writers echo each other into a flip-flop loop.

export type ClientLine = { isOpen(): boolean; send(frame: string): void; close(): void };
export type OpenLine = (url: string, headers: Readonly<Record<string, string>>) => ClientLine;

export const clientSocketUrl = async (slack: Slack, token: string): Promise<string> => {
  const res = await slack.call("client.getWebSocketURL", {});
  if (typeof res.primary_websocket_url !== "string" || typeof res.routing_context !== "string") throw new Error("client.getWebSocketURL returned an unexpected shape");
  const url = new URL(res.primary_websocket_url);
  const params: Record<string, string> = {
    token,
    sync_desync: "1",
    slack_client: "desktop",
    start_args: "?agent=client&org_wide_aware=true&connect_only=true&ms_latest=true",
    no_query_on_subscribe: "1",
    flannel: "3",
    lazy_channels: "1",
    gateway_server: res.routing_context,
    batch_presence_aware: "1",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

export const slackPresence = (slack: Slack, open: OpenLine, auth: { readonly token: string; readonly cookie: string }) => {
  let line: ClientLine | null = null;
  let id = 0;
  return {
    async hold(): Promise<"opened" | "tickled"> {
      if (line?.isOpen()) {
        line.send(JSON.stringify({ type: "tickle", id: ++id }));
        return "tickled";
      }
      await slack.setPresence("auto");
      line = open(await clientSocketUrl(slack, auth.token), { Cookie: `d=${auth.cookie}`, Origin: "https://app.slack.com" });
      return "opened";
    },
    async release(): Promise<void> {
      line?.close();
      line = null;
      await slack.setPresence("away");
    },
  };
};

export type Platform = "slack" | "telegram" | "discord";
export type MessengerOrigin = { platform: Platform; target: string; thread?: string; account?: string; workspace?: string; sourceMessage?: string };
export type MessengerConfig = { enabled: boolean; platform: Platform; credential: string; cookie?: string };
export type MessengerSend = MessengerConfig & MessengerOrigin & { text: string; edit?: string };
export type MessengerReceipt = { platform: Platform; target: string; thread?: string; messageId: string; edited: boolean };
const parseBody = (body: string): any => { try { return JSON.parse(body || "{}"); } catch { throw new MessengerUncertain(); } };
export class MessengerUncertain extends Error { constructor() { super("messenger delivery is unconfirmed; inspect platform history before reconciliation"); } }

const checked = (value: string, label: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) throw new Error(`invalid messenger ${label}`);
  return value;
};
const checkedOrigin = (origin: MessengerOrigin, requireAccount = true): MessengerOrigin => {
  if (!["slack", "telegram", "discord"].includes(origin.platform)) throw new Error("unknown messenger platform");
  checked(origin.target, "target"); if (requireAccount && !origin.account) throw new Error("messenger origin requires an explicit account identity"); if (origin.workspace !== undefined) checked(origin.workspace, "workspace"); if (origin.sourceMessage !== undefined) checked(origin.sourceMessage, "source message"); if (origin.thread !== undefined) checked(origin.thread, "thread"); if (origin.account !== undefined) checked(origin.account, "account");
  if (origin.platform === "discord" && ![origin.target, origin.thread ?? origin.target].every(x => /^[a-zA-Z0-9_-]+$/.test(x))) throw new Error("invalid discord route");
  if (origin.platform === "telegram" && origin.thread !== undefined && !/^[1-9][0-9]*$/.test(origin.thread)) throw new Error("invalid telegram topic");
  return { platform: origin.platform, target: origin.target, ...(origin.thread !== undefined ? { thread: origin.thread } : {}), ...(origin.account !== undefined ? { account: origin.account } : {}), ...(origin.workspace !== undefined ? { workspace: origin.workspace } : {}), ...(origin.sourceMessage !== undefined ? { sourceMessage: origin.sourceMessage } : {}) };
};
const originKey = (origin: MessengerOrigin): string => JSON.stringify(checkedOrigin(origin));
const inboundRouteKey = (origin: MessengerOrigin): string => { const { sourceMessage: _source, ...route } = checkedOrigin(origin); return JSON.stringify(route); };
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Explicit invocation only. No environment reads, login, listeners or presence by default. */
export async function sendMessenger(input: MessengerSend, http: Http = fetchHttp, clock: Clock = realClock): Promise<MessengerReceipt> {
  if (input.enabled !== true) throw new Error("messenger integration is disabled");
  checked(input.credential, "credential"); checkedOrigin(input, false); guardText(input.text);
  let messageId: string;
  if (input.platform === "slack") {
    const slack = new Slack(http, clock, { token: input.credential, cookie: input.cookie });
    if (input.edit) { await slack.edit(input.target, checked(input.edit, "message"), input.text); messageId = input.edit; }
    else messageId = (await slack.post(input.target, input.text, input.thread)).ts;
  } else if (input.platform === "telegram") {
    const tg = new Telegram(http, clock, input.credential), target = { chatId: input.target, ...(input.thread ? { threadId: Number(input.thread) } : {}) };
    if (input.edit) {
      if (!/^[1-9][0-9]*$/.test(input.edit)) throw new Error("invalid telegram message");
      await tg.edit(target, Number(input.edit), input.text); messageId = input.edit;
    } else messageId = String(await tg.send(target, input.text));
  } else {
    const dc = new Discord(http, clock, input.credential), channel = input.thread ?? input.target;
    if (input.edit) { if (!/^[a-zA-Z0-9_-]+$/.test(input.edit)) throw new Error("invalid discord message"); await dc.edit(channel, input.edit, input.text); messageId = input.edit; }
    else messageId = await dc.send(channel, input.text);
  }
  if (typeof messageId !== "string" || !messageId || messageId === "undefined" || messageId === "null") throw new MessengerUncertain();
  return { platform: input.platform, target: input.target, ...(input.thread ? { thread: input.thread } : {}), messageId, edited: !!input.edit };
}

export type InboundEnvelope = { id: string; origin: MessengerOrigin; authorId: string; text: string; quoted?: boolean; forwarded?: boolean };
export type InboundRecord = { event: InboundEnvelope; task?: string; receivedAt: number; handledAt?: number };
export type DeliveryRecord = { id: string; origin: MessengerOrigin; fingerprint: string; state: "sending" | "sent" | "uncertain" | "rejected"; at: number; messageId?: string };
type JournalData = { bindings: Record<string, MessengerOrigin>; inbound: Record<string, InboundRecord>; outgoing: Record<string, DeliveryRecord> };
const taskKey = (key: string): string => { if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(key)) throw new Error("invalid messenger task key"); return key; };

/** Private delivery state, separate from the task ledger. Never stores credentials or exception bodies. */
export class MessengerJournal {
  readonly root: string;
  private readonly file: string;
  constructor(home: string) {
    this.root = join(home, "messenger"); mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.file = join(this.root, "journal.json");
  }
  private read(): JournalData { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : { bindings: {}, inbound: {}, outgoing: {} }; }
  private edit<T>(action: (state: JournalData) => T): T {
    const lease = acquireFileLease(join(this.root, "journal.lock")); if (!lease) throw new Error("messenger journal busy; retry after the active operation");
    try {
      const state = this.read(), result = action(state), tmp = `${this.file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, this.file); return result;
    } finally { lease.release(); }
  }
  bindings(): Record<string, MessengerOrigin> { return this.read().bindings; }
  bindTask(task: string, origin: MessengerOrigin): void {
    taskKey(task); const normalized = checkedOrigin(origin);
    this.edit(state => { const old = Object.hasOwn(state.bindings, task) ? state.bindings[task] : undefined; if (old && originKey(old) !== originKey(normalized)) throw new Error("task is already bound to another messenger origin"); Object.defineProperty(state.bindings, task, { value: normalized, enumerable: true, configurable: true, writable: true }); });
  }
  origin(task: string): MessengerOrigin | undefined { const bindings = this.read().bindings; taskKey(task); return Object.hasOwn(bindings, task) ? bindings[task] : undefined; }
  inbound(): InboundRecord[] { return Object.values(this.read().inbound); }
  outgoing(): DeliveryRecord[] { return Object.values(this.read().outgoing); }
  /** verify must authenticate the raw platform event outside this normalized contract. */
  async acceptInbound(event: InboundEnvelope, opts: { ownerId: string; verify: (event: InboundEnvelope) => Promise<boolean>; task?: string }): Promise<{ duplicate: boolean; task?: string; event: InboundEnvelope }> {
    checked(event.id, "event id"); checked(event.authorId, "author");
    if (typeof event.text !== "string" || !event.text.trim() || event.text.length > 64_000 || (event.quoted !== undefined && typeof event.quoted !== "boolean") || (event.forwarded !== undefined && typeof event.forwarded !== "boolean")) throw new Error("invalid inbound message");
    const normalized: InboundEnvelope = Object.freeze({ id: event.id, origin: Object.freeze(checkedOrigin(event.origin)), authorId: event.authorId, text: event.text, ...(event.quoted !== undefined ? { quoted: event.quoted } : {}), ...(event.forwarded !== undefined ? { forwarded: event.forwarded } : {}) });
    if (normalized.authorId !== opts.ownerId || normalized.quoted || normalized.forwarded) throw new Error("inbound message is not a verified owner request");
    let verified = false; try { verified = await opts.verify(normalized); } catch { throw new Error("inbound authentication failed"); }
    if (!verified) throw new Error("inbound message is not a verified owner request");
    if (opts.task) taskKey(opts.task);
    return this.edit(state => {
      const id = hash([normalized.origin.platform, normalized.origin.account ?? "", normalized.origin.workspace ?? "", normalized.id]);
      const bound = opts.task && Object.hasOwn(state.bindings, opts.task) ? state.bindings[opts.task] : undefined;
      if (opts.task && (!bound || inboundRouteKey(bound) !== inboundRouteKey(normalized.origin))) throw new Error("inbound origin does not match the task");
      const old = state.inbound[id];
      if (old) {
        if (hash(old.event) !== hash(normalized) || old.task !== opts.task) throw new Error("inbound event id conflicts with its recorded request");
        return { duplicate: true, task: old.task, event: old.event };
      }
      state.inbound[id] = { event: normalized, task: opts.task, receivedAt: Date.now() };
      return { duplicate: false, task: opts.task, event: normalized };
    });
  }
  markInboundHandled(platform: Platform, account: string | undefined, eventId: string, workspace?: string): void {
    this.edit(state => { const event = state.inbound[hash([platform, account ?? "", workspace ?? "", eventId])]; if (!event) throw new Error("unknown inbound event"); event.handledAt ??= Date.now(); });
  }
  async deliver(id: string, origin: MessengerOrigin, text: string, send: () => Promise<{ messageId: string }>): Promise<DeliveryRecord> {
    checked(id, "delivery id"); const normalized = checkedOrigin(origin); guardText(text); const fingerprint = hash([normalized, text]);
    const lease = acquireFileLease(join(this.root, `delivery-${hash(id)}.lock`)); if (!lease) throw new Error("messenger delivery is already in progress");
    try {
      const prior = this.read().outgoing[hash(id)];
      if (prior) {
        if (prior.fingerprint !== fingerprint || originKey(prior.origin) !== originKey(normalized)) throw new Error("delivery id conflicts with its original content or origin");
        if (prior.state === "sent") return prior;
        throw new MessengerUncertain(); // A crash after send but before receipt is never replayed.
      }
      this.edit(state => { state.outgoing[hash(id)] = { id, origin: normalized, fingerprint, state: "sending", at: Date.now() }; });
      try {
        const receipt = await send(); checked(receipt.messageId, "receipt");
        return this.edit(state => { const record = state.outgoing[hash(id)]!; record.state = "sent"; record.messageId = receipt.messageId; return record; });
      } catch (error) {
        const definitive = error instanceof MessengerError && error.status < 500;
        this.edit(state => { state.outgoing[hash(id)]!.state = definitive ? "rejected" : "uncertain"; });
        if (definitive) throw new MessengerError("messenger rejected the request", (error as MessengerError).status);
        throw new MessengerUncertain();
      }
    } finally { lease.release(); }
  }
  async reply(task: string, id: string, text: string, send: (origin: MessengerOrigin) => Promise<{ messageId: string }>): Promise<DeliveryRecord> {
    const origin = this.origin(task); if (!origin) throw new Error("task has no messenger origin"); return this.deliver(id, origin, text, () => send(origin));
  }
  reconcile(id: string, delivered: boolean, messageId?: string): void {
    if (delivered) checked(messageId!, "receipt");
    this.edit(state => { const old = state.outgoing[hash(id)]; if (!old || !["sending", "uncertain"].includes(old.state)) throw new Error("only uncertain delivery can be reconciled"); old.state = delivered ? "sent" : "rejected"; if (delivered) old.messageId = messageId; });
  }
}

export const tsAfter = (a: string, b: string): boolean => {
  const parse = (value: string): [bigint, bigint] => { const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value); if (!match) throw new Error("invalid slack timestamp"); return [BigInt(match[1]!), BigInt((match[2] ?? "").padEnd(6, "0"))]; };
  const x = parse(a), y = parse(b); return x[0] > y[0] || (x[0] === y[0] && x[1] > y[1]);
};
export type LedgerThread = { channel: string; rootTs: string; seenTs: string; account?: string; workspace?: string };
export class ThreadLedger {
  constructor(private readonly file: string, private readonly scope: { account?: string; workspace?: string } = {}) {}
  private sameScope(t: LedgerThread): boolean { return t.account === this.scope.account && t.workspace === this.scope.workspace; }
  private read(): LedgerThread[] { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : []; }
  async load(): Promise<void> { /* Every operation rereads shared persisted state. */ }
  private edit(action: (threads: LedgerThread[]) => void): void {
    mkdirSync(join(this.file, ".."), { recursive: true, mode: 0o700 });
    const lease = acquireFileLease(this.file + ".lock"); if (!lease) throw new Error("thread ledger busy");
    try { const threads = this.read(); action(threads); const tmp = `${this.file}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(threads) + "\n", { mode: 0o600 }); renameSync(tmp, this.file); } finally { lease.release(); }
  }
  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    this.edit(threads => { const old = threads.find(t => this.sameScope(t) && t.channel === channel && t.rootTs === rootTs); if (old) { if (tsAfter(postedTs, old.seenTs)) old.seenTs = postedTs; } else threads.push({ channel, rootTs, seenTs: postedTs, ...this.scope }); });
  }
  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> { this.edit(threads => { const old = threads.find(t => this.sameScope(t) && t.channel === channel && t.rootTs === rootTs); if (old && tsAfter(ts, old.seenTs)) old.seenTs = ts; }); }
  async list(): Promise<LedgerThread[]> { return this.read().filter(t => this.sameScope(t)); }
}

export type Inbound = { source: "threads-view" | "own-thread" | "unread"; channel: string; ts: string; threadTs?: string; user?: string; text?: string };
type SlackMessage = { ts?: string; thread_ts?: string; user?: string; text?: string; bot_id?: string; channel?: string };
/** Read-only upstream Slack thread-view + watched-thread + unread sweep. Caller owns authentication/dispatch. */
export async function pollSlackInbound(slack: Slack, ledger: ThreadLedger, opts: { selfUserId: string; threadsViewLimit?: number }): Promise<Inbound[]> {
  const out: Inbound[] = [], seen = new Set<string>();
  const add = (entry: Inbound) => { const id = JSON.stringify([entry.channel, entry.ts]); if (!seen.has(id)) { seen.add(id); out.push(entry); } };
  const fromOthers = (m: SlackMessage) => !!m.user && m.user !== opts.selfUserId && !m.bot_id;
  const view = await slack.call("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 }) as { threads?: { root_msg?: SlackMessage; unread_replies?: SlackMessage[] }[] };
  for (const thread of view.threads ?? []) {
    const channel = thread.root_msg?.channel; if (!channel) continue;
    for (const m of thread.unread_replies ?? []) if (m.ts && fromOthers(m)) add({ source: "threads-view", channel, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text });
  }
  for (const thread of await ledger.list()) {
    const res = await slack.call("conversations.replies", { channel: thread.channel, ts: thread.rootTs, oldest: thread.seenTs, inclusive: false, limit: 50 }) as { messages?: SlackMessage[] };
    for (const m of res.messages ?? []) if (m.ts && tsAfter(m.ts, thread.seenTs) && fromOthers(m)) add({ source: "own-thread", channel: thread.channel, ts: m.ts, threadTs: thread.rootTs, user: m.user, text: m.text });
  }
  // Cursors advance only when the caller durably accepts a returned owner event.
  const counts = await slack.call("client.counts", {}) as { channels?: { id: string; has_unreads?: boolean; mention_count?: number }[]; ims?: { id: string; has_unreads?: boolean; mention_count?: number }[]; mpims?: { id: string; has_unreads?: boolean; mention_count?: number }[] };
  for (const c of [...counts.ims ?? [], ...counts.mpims ?? [], ...(counts.channels ?? []).filter(c => (c.mention_count ?? 0) > 0)]) if (c.has_unreads || (c.mention_count ?? 0) > 0) add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  return out;
}

export class TranscriptionError extends Error {}
export async function transcribe(run: (argv: readonly string[]) => Promise<{ code: number; out: string; err: string }>, hook: readonly string[] | undefined, audioPath: string): Promise<string> {
  if (!hook?.length || !hook.some(arg => arg.includes("{file}")) || hook.some(arg => typeof arg !== "string" || /[\0]/.test(arg))) throw new TranscriptionError("no valid transcription argv hook configured");
  const result = await run(hook.map(arg => arg.replaceAll("{file}", audioPath)));
  if (result.code !== 0 || !result.out.trim()) throw new TranscriptionError("transcription failed");
  return result.out.trim();
}
export const asOwnerMessage = (transcript: string): string => `[voice] ${transcript}`;
