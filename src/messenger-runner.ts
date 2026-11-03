// Explicit inbound service adapted from upstream 90f02c19's messenger CLI,
// Slack polling/thread ledger and Discord gateway heartbeat. No import-time IO.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { acquireFileLease, type FileLease } from "./lock.ts";
import { Refusal, type Deps } from "./harness.ts";
import { admitMessengerRequest } from "./messenger-bridge.ts";
import { deliverExternalNotice, notices, recordNotice } from "./notifications.ts";
import {
  Discord, Slack, Telegram, ThreadLedger, MessengerJournal, fetchHttp, realClock, realTimers,
  pollSlackInbound, tsAfter, type Http, type Clock, type Timers, type InboundEnvelope, type MessengerOrigin, type Platform,
} from "./messenger.ts";

export type RunnerConfig = {
  enabled: true; platform: Platform; credential: string; cookie?: string;
  account: string; ownerId: string; workspace?: string; targets: string[];
  /** Slack's explicit history lower bound, never inferred from local wall time. */
  since?: string; upstreamDiscovery?: boolean; intervalMs: number;
  /** Initial Discord snowflake lower bounds, one for every explicit target. */
  after?: Record<string, string>;
};
type Disabled = { enabled: false };
const string = (x: unknown): x is string => typeof x === "string" && !!x.trim() && x.length <= 512 && !/[\r\n\0]/.test(x);
export function runnerConfig(raw: unknown): RunnerConfig | Disabled {
  const c = raw as Record<string, unknown> | null;
  if (!c || typeof c !== "object") throw new Refusal("messenger configuration must be an object");
  // Do not inspect credential properties on the disabled path.
  if (c.enabled === false) return { enabled: false };
  if (c.enabled !== true) throw new Refusal("messenger configuration requires explicit enabled:true or false");
  if (!["slack", "telegram", "discord"].includes(String(c.platform))) throw new Refusal("invalid messenger platform");
  for (const key of ["credential", "account", "ownerId"]) if (!string(c[key])) throw new Refusal(`messenger configuration requires ${key}`);
  if (!Array.isArray(c.targets) || !c.targets.length || c.targets.some(t => !string(t)) || new Set(c.targets).size !== c.targets.length) throw new Refusal("messenger targets must be an explicit nonempty unique allowlist");
  if (c.platform !== "telegram" && !string(c.workspace)) throw new Refusal("Slack/Discord require an explicit workspace (team/guild ID)");
  if (c.platform === "telegram" && c.workspace !== undefined) throw new Refusal("Telegram has no workspace identity");
  if (c.cookie !== undefined && (c.platform !== "slack" || !string(c.cookie))) throw new Refusal("cookie is supported only for explicit Slack user configuration");
  if (c.platform === "slack" && (!string(c.since) || !/^\d+\.\d{1,6}$/.test(c.since))) throw new Refusal("Slack requires explicit since timestamp, e.g. 1790000000.000000");
  if (c.upstreamDiscovery !== undefined && typeof c.upstreamDiscovery !== "boolean") throw new Refusal("upstreamDiscovery must be boolean");
  const intervalMs = c.intervalMs ?? 2000;
  if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) throw new Refusal("intervalMs must be an integer from 250 to 60000");
  const targets = c.targets as string[];
  if (c.platform === "discord" && ![c.account, c.ownerId, c.workspace, ...targets].every(v => /^\d+$/.test(String(v)))) throw new Refusal("Discord IDs must be numeric");
  if (c.platform === "slack" && ![c.account, c.ownerId, c.workspace, ...targets].every(v => /^[A-Z0-9]+$/.test(String(v)))) throw new Refusal("Slack IDs must be uppercase alphanumeric platform IDs");
  if (c.platform === "discord" && (!c.after || typeof c.after !== "object" || Array.isArray(c.after) || targets.some(t => typeof (c.after as any)[t] !== "string" || !/^\d+$/.test((c.after as any)[t])) || Object.keys(c.after).some(t => !targets.includes(t)))) throw new Refusal("Discord requires explicit after message IDs for every target (0 means all accessible history)");
  if (c.platform === "telegram" && (!/^\d+$/.test(String(c.account)) || !/^\d+$/.test(String(c.ownerId)) || targets.some(t => !/^-?\d+$/.test(t)))) throw new Refusal("Telegram IDs must be numeric");
  return { enabled: true, platform: c.platform as Platform, credential: c.credential as string, account: c.account as string, ownerId: c.ownerId as string,
    targets: [...targets], intervalMs, ...(c.workspace ? { workspace: c.workspace as string } : {}), ...(c.cookie ? { cookie: c.cookie as string } : {}),
    ...(c.since ? { since: c.since as string } : {}), ...(c.platform === "discord" ? { after: { ...c.after as Record<string, string> } } : {}), ...(c.upstreamDiscovery === true ? { upstreamDiscovery: true } : {}) };
}
/** Only a user-requested start/check reads this explicit file. No env/keychain lookup. */
export function readRunnerConfig(file: string): RunnerConfig | Disabled {
  if (!isAbsolute(file)) throw new Refusal("--config must be an absolute explicit file path");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Refusal("cannot read messenger configuration JSON"); }
  return runnerConfig(raw);
}
export function runnerExample(platform: string): Record<string, unknown> {
  if (!["slack", "telegram", "discord"].includes(platform)) throw new Refusal("choose slack, telegram or discord");
  return { enabled: false, platform, credential: "REPLACE_WITH_EXPLICIT_TOKEN", account: "AUTHENTICATED_BOT_OR_USER_ID", ownerId: "OWNER_USER_ID", targets: ["CHANNEL_OR_CHAT_ID"],
    ...(platform !== "telegram" ? { workspace: "TEAM_OR_GUILD_ID" } : {}), ...(platform === "slack" ? { since: "1790000000.000000", upstreamDiscovery: false } : {}), ...(platform === "discord" ? { after: { CHANNEL_OR_CHAT_ID: "MESSAGE_ID_OR_0" } } : {}), intervalMs: 2000 };
}
type Scope = Pick<RunnerConfig, "platform" | "account" | "workspace">;
const identity = (c: Scope) => createHash("sha256").update(JSON.stringify([c.platform, c.account, c.workspace ?? ""])).digest("hex");
const atomic = (file: string, value: unknown) => { const tmp = `${file}.${randomUUID()}.tmp`; writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); renameSync(tmp, file); };
const routeKey = (o: MessengerOrigin) => JSON.stringify([o.platform, o.account, o.workspace, o.target, o.thread]);
export type RunnerState = {
  id: string; run: string; platform: Platform; account: string; workspace?: string; ownerId: string; targets: string[];
  state: "starting" | "running" | "stopping" | "stopped" | "failed"; at: number; issue?: string;
  telegramOffset: number; slack: Record<string, string>;
  discord?: { session: string; url: string; seq: number | null };
  discordAfter: Record<string, string>;
  rejected: Record<string, number>; blockedDeliveries: string[];
};
const directory = (home: string) => join(home, "messenger", "runners");
export function runnerStatus(home: string): RunnerState[] {
  const dir = directory(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as RunnerState);
}
/** Cooperative stop, scoped to a run nonce. Never signals a shared runtime or a PID. */
export function requestRunnerStop(home: string, id: string): void {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Refusal("use the exact runner ID from messenger status");
  const file = join(directory(home), `${id}.json`);
  if (!existsSync(file)) throw new Refusal("unknown messenger runner");
  const state = JSON.parse(readFileSync(file, "utf8")) as RunnerState;
  atomic(join(directory(home), `${id}.stop.json`), { run: state.run });
}
export type RunnerSocket = { send(data: string): void; close(): void; onMessage(cb: (data: string) => void): void; onClose(cb: () => void): void };
export type RunnerIO = { http: Http; clock: Clock; timers: Timers; openSocket(url: string): RunnerSocket };
export const runnerIO = (): RunnerIO => ({ http: fetchHttp, clock: realClock, timers: realTimers, openSocket: url => {
  const socket = new WebSocket(url);
  let message = (_raw: string) => {}, closed = () => {};
  socket.addEventListener("message", e => message(String(e.data)));
  socket.addEventListener("close", () => closed()); socket.addEventListener("error", () => { socket.close(); closed(); });
  return { send: data => { socket.send(data); }, close: () => socket.close(), onMessage: cb => { message = cb; }, onClose: cb => { closed = cb; } };
} });
const discordUrl = (value: unknown): string => {
  if (typeof value !== "string") throw new Refusal("Discord gateway URL missing");
  const u = new URL(value);
  if (u.protocol !== "wss:" || u.username || u.password || u.port || !(u.hostname === "gateway.discord.gg" || /^gateway-[a-z0-9-]+\.discord\.gg$/.test(u.hostname))) throw new Refusal("untrusted Discord gateway URL");
  u.search = "?v=10&encoding=json"; return u.toString();
};

export class MessengerRunner {
  readonly config: RunnerConfig;
  readonly state: RunnerState;
  private readonly file: string;
  private readonly lease: FileLease;
  private readonly journal: MessengerJournal;
  private readonly ledger: ThreadLedger;
  private readonly http: Http;
  private readonly abort = new AbortController();
  private socket?: RunnerSocket;
  private heartbeat?: unknown;
  private heartbeatAck = true;
  private tail: Promise<void> = Promise.resolve();
  private stopping = false;
  private closed = false;
  private gateway = "wss://gateway.discord.gg/?v=10&encoding=json";
  private reconnectAt = 0;
  private reconnects = 0;
  private monitor?: unknown;

  constructor(readonly d: Deps, config: RunnerConfig, readonly io: RunnerIO = runnerIO()) {
    // A single explicit service per authenticated account/workspace. No default connector.
    const checked = runnerConfig(config);
    if (!checked.enabled) throw new Refusal("messenger runner is disabled");
    this.config = Object.freeze({ ...checked, targets: Object.freeze([...checked.targets]) as unknown as string[] });
    config = this.config;
    const roles = d.store.roles();
    if (!roles.lead || !roles.conversation || roles.lead === roles.conversation) throw new Refusal("messenger runners require a registered separate work lead and conversation");
    const dir = directory(d.store.root); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = identity(config); this.file = join(dir, `${id}.json`);
    const lease = acquireFileLease(join(dir, `${id}.lock`)); if (!lease) throw new Refusal("messenger runner already active for this account/workspace");
    this.lease = lease;
    try {
      const saved = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) as RunnerState : undefined;
      if (saved && (saved.id !== id || saved.ownerId !== config.ownerId || JSON.stringify(saved.targets) !== JSON.stringify(config.targets))) throw new Refusal("runner owner/target configuration differs from its durable cursors; use a separate DORI_HOME");
      if (saved) {
        const ts = (value: unknown) => typeof value === "string" && /^\d+\.\d{1,6}$/.test(value);
        if (saved.platform !== config.platform || saved.account !== config.account || saved.workspace !== config.workspace || !Number.isSafeInteger(saved.telegramOffset) || saved.telegramOffset < 0 || !saved.slack || typeof saved.slack !== "object" || Object.values(saved.slack).some(v => !ts(v)) || !saved.rejected || typeof saved.rejected !== "object") throw new Refusal("invalid durable messenger cursor state; inspect before recovery");
        if (config.platform === "discord" && (!saved.discordAfter || config.targets.some(t => typeof saved.discordAfter[t] !== "string" || !/^\d+$/.test(saved.discordAfter[t]!)))) throw new Refusal("invalid durable Discord history cursor; inspect before recovery");
        if (saved.discord) {
          if (!string(saved.discord.session) || !(saved.discord.seq === null || Number.isSafeInteger(saved.discord.seq) && saved.discord.seq >= 0)) throw new Refusal("invalid durable Discord session");
          discordUrl(saved.discord.url);
        }
      }
      this.state = { id, run: randomUUID(), platform: config.platform, account: config.account, workspace: config.workspace, ownerId: config.ownerId, targets: [...config.targets], state: "starting", at: io.clock.now(),
        telegramOffset: saved?.telegramOffset ?? 0, slack: saved?.slack ?? {}, discord: saved?.discord, discordAfter: saved?.discordAfter ?? { ...config.after }, rejected: saved?.rejected ?? {}, blockedDeliveries: [] };
      this.save();
      this.journal = new MessengerJournal(d.store.root);
      this.ledger = new ThreadLedger(join(d.store.root, "messenger", "slack-threads.json"), { account: config.account, workspace: config.workspace });
      this.http = req => { this.checkStop(); if (this.stopping) return Promise.reject(new Refusal("runner stopped")); return io.http({ ...req, signal: this.abort.signal }); };
      this.monitor = io.timers.setInterval(() => { this.checkStop(); }, 250);
    } catch (e) { lease.release(); throw e; }
  }
  private save(): void { this.state.at = this.io.clock.now(); atomic(this.file, this.state); }
  private checkStop(): void {
    const file = join(directory(this.d.store.root), `${this.state.id}.stop.json`);
    try { if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).run === this.state.run) this.beginStop(); }
    catch { this.state.issue = "stop-control-unreadable"; this.beginStop(); }
  }
  private beginStop(): void {
    if (this.stopping) return;
    this.stopping = true; this.state.state = "stopping"; this.save(); this.abort.abort(); this.disconnect();
  }
  private serialize(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work); this.tail = next.catch(() => {}); return next;
  }
  private reject(reason: string): void { this.state.rejected[reason] = (this.state.rejected[reason] ?? 0) + 1; }
  private scope(o: MessengerOrigin): boolean { return o.platform === this.config.platform && o.account === this.config.account && o.workspace === this.config.workspace && this.config.targets.includes(o.target); }
  private async admit(event: InboundEnvelope): Promise<void> {
    if (this.stopping) throw new Refusal("runner stopped");
    if (!this.scope(event.origin)) throw new Refusal("event outside configured messenger scope");
    const prior = this.journal.inbound().find(r => r.event.id === event.id && this.scope(r.event.origin));
    let task = prior?.task;
    if (!prior) {
      const candidates = this.d.store.lanes().filter(l => !["done", "lost"].includes(l.status) && l.origin?.kind === "messenger" && routeKey(l.origin.origin) === routeKey(event.origin));
      if (candidates.length > 1) throw new Refusal("ambiguous messenger route: multiple open task instances; retained without cursor advance");
      task = candidates[0]?.threadId;
    }
    // This callback is internal to the authenticated provider consumer, never a JSON ingress endpoint.
    await admitMessengerRequest(this.d, event, { ownerId: this.config.ownerId, verify: async e => this.scope(e.origin), task });
  }
  private async recover(): Promise<void> {
    for (const r of this.journal.inbound()) if (!r.handledAt && this.scope(r.event.origin)) await this.admit(r.event);
  }
  private async dispatch(): Promise<void> {
    // Recover the DONE -> outbox write gap without invoking the duty/backlog loop.
    for (const lane of this.d.store.lanes()) for (const c of lane.completions ?? []) {
      if (c.origin.kind !== "messenger" || !this.scope(c.origin.origin)) continue;
      recordNotice(this.d, { task: c.task, instance: c.instance, revision: c.revision, kind: "completion", summary: c.summary, decision: c.decision, details: c.details }, `done:${c.instance}:${c.revision}`, c.at);
    }
    const blocked: string[] = [];
    for (const n of notices(this.d).notices) {
      if (this.stopping) break;
      if (n.kind !== "completion" || n.externalReceipt || !n.origin || !this.scope(n.origin)) continue;
      const prior = this.journal.outgoing().find(r => r.id === n.id);
      if (prior && prior.state !== "sent") { blocked.push(n.id); continue; }
      try { await deliverExternalNotice(this.d, n.id, this.config, this.http, this.io.clock); }
      catch { blocked.push(n.id); } // Detailed platform errors/credentials never reach state/logs.
    }
    this.state.blockedDeliveries = blocked;
  }
  async start(): Promise<void> {
    return this.serialize(async () => {
      try {
        const c = this.config;
        if (c.platform === "telegram") {
          const tg = new Telegram(this.http, this.io.clock, c.credential);
          const me = await tg.call<any>("getMe", {});
          if (String(me.id) !== c.account || me.is_bot !== true) throw new Refusal("Telegram authenticated account mismatch");
          const hook = await tg.call<any>("getWebhookInfo", {});
          if (typeof hook.url !== "string" || hook.url) throw new Refusal("Telegram webhook configured or unconfirmed; remove it explicitly before polling");
        } else if (c.platform === "slack") {
          const me = await new Slack(this.http, this.io.clock, { token: c.credential, cookie: c.cookie }).call("auth.test", {});
          if (me.user_id !== c.account || me.team_id !== c.workspace) throw new Refusal("Slack authenticated account/workspace mismatch");
        } else {
          const dc = new Discord(this.http, this.io.clock, c.credential);
          const me = await dc.call<any>("GET", "/users/@me");
          if (me.id !== c.account || me.bot !== true) throw new Refusal("Discord authenticated bot account mismatch");
          const gateway = await dc.call<any>("GET", "/gateway/bot"); this.gateway = discordUrl(gateway.url);
          for (const id of c.targets) {
            const channel = await dc.call<any>("GET", `/channels/${id}`);
            if (channel.id !== id || channel.guild_id !== c.workspace || ![0, 5, 10, 11, 12].includes(channel.type)) throw new Refusal("Discord target does not belong to configured guild or supported message channel");
          }
          await this.pollDiscord();
        }
        this.checkStop(); if (this.stopping) return;
        this.state.state = "running"; this.save();
        if (c.platform === "discord") this.connect();
      } catch { this.state.issue = "startup-failed"; this.state.state = "failed"; this.save(); throw new Refusal("messenger startup failed; check configured identity, provider setup and permissions (provider error redacted)"); }
    });
  }
  async tick(): Promise<void> {
    return this.serialize(async () => {
      this.checkStop(); if (this.stopping) return;
      if (this.state.state !== "running") throw new Refusal("messenger runner has not started");
      try {
        // Completions continue even when inbound polling is temporarily unavailable.
        await this.dispatch();
        await this.recover();
        if (this.config.platform === "telegram") await this.pollTelegram();
        if (this.config.platform === "slack") await this.pollSlack();
        if (this.config.platform === "discord") {
          await this.pollDiscord();
          if (!this.socket && this.io.clock.now() >= this.reconnectAt) this.connect();
        }
        delete this.state.issue;
      } catch { if (!this.stopping) this.state.issue = "cycle-unconfirmed"; }
      this.save();
    });
  }
  private origin(target: string, sourceMessage: string, thread?: string): MessengerOrigin {
    return { platform: this.config.platform, account: this.config.account, ...(this.config.workspace ? { workspace: this.config.workspace } : {}), target, sourceMessage, ...(thread ? { thread } : {}) };
  }
  private async pollTelegram(): Promise<void> {
    const updates = await new Telegram(this.http, this.io.clock, this.config.credential).call<any>("getUpdates", { offset: this.state.telegramOffset, timeout: 0, limit: 100, allowed_updates: ["message"] });
    if (!Array.isArray(updates) || updates.some(u => !Number.isSafeInteger(u?.update_id) || u.update_id < 0 || u.update_id >= Number.MAX_SAFE_INTEGER)) throw new Refusal("malformed Telegram update batch");
    for (const u of [...updates].sort((a, b) => a.update_id - b.update_id)) {
      if (u.update_id < this.state.telegramOffset) continue;
      const m = u.message;
      if (!m || !Number.isSafeInteger(m.message_id) || !Number.isSafeInteger(m.chat?.id) || !Number.isSafeInteger(m.from?.id) || m.from.is_bot !== false || typeof m.text !== "string" || !m.text.trim() || m.text.length > 64_000 || m.forward_origin || m.forward_date || m.quote || m.sender_chat || m.via_bot || (m.message_thread_id !== undefined && (!Number.isSafeInteger(m.message_thread_id) || m.message_thread_id <= 0))) this.reject("malformed-or-bot-or-forwarded");
      else if (String(m.from.id) !== this.config.ownerId || !this.config.targets.includes(String(m.chat.id))) this.reject("unauthorized");
      else await this.admit({ id: String(u.update_id), authorId: String(m.from.id), origin: this.origin(String(m.chat.id), String(m.message_id), m.message_thread_id ? String(m.message_thread_id) : undefined), text: m.text });
      this.state.telegramOffset = u.update_id + 1; this.save();
    }
  }
  private async slackMessage(channel: string, m: any, root?: string): Promise<void> {
    if (typeof m?.ts !== "string" || !/^\d+\.\d{1,6}$/.test(m.ts)) throw new Refusal("Slack message timestamp missing");
    if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 64_000 || m.subtype || m.bot_id || m.attachments?.length || m.user !== this.config.ownerId || !this.config.targets.includes(channel) || m.text.trimStart().startsWith(">") || m.text.includes("<blockquote>") || m.blocks?.some?.((b: any) => b?.type === "rich_text" && JSON.stringify(b).includes("rich_text_quote"))) { this.reject("unauthorized-or-nonrequest"); return; }
    const thread = root ?? m.thread_ts ?? m.ts;
    if (typeof thread !== "string" || !/^\d+\.\d{1,6}$/.test(thread)) throw new Refusal("invalid Slack thread");
    await this.admit({ id: `${channel}:${m.ts}`, authorId: m.user, origin: this.origin(channel, m.ts, thread), text: m.text });
    // Watch every admitted root even before the work lead starts its task.
    const existing = (await this.ledger.list()).find(t => t.channel === channel && t.rootTs === thread);
    if (!existing) await this.ledger.record(channel, thread, thread);
  }
  private async slackPage(slack: Slack, method: string, params: Record<string, unknown>, visit: (m: any) => Promise<void>): Promise<void> {
    let cursor = ""; const seen = new Set<string>(), messages: any[] = [];
    // Exhaust pagination before advancing a high watermark; partial failures are safely deduplicated.
    for (let page = 0; page < 100; page++) {
      const r = await slack.call(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(r.messages)) throw new Refusal("malformed Slack history");
      messages.push(...r.messages);
      const next = (r.response_metadata as any)?.next_cursor;
      if (!next) {
        if (r.has_more === true) throw new Refusal("Slack history incomplete without cursor");
        // Slack pages run newest-first: order the complete snapshot before admitting pivots.
        messages.sort((a, b) => a.ts === b.ts ? 0 : tsAfter(a.ts, b.ts) ? 1 : -1);
        for (const m of messages) await visit(m);
        return;
      }
      if (typeof next !== "string" || seen.has(next)) throw new Refusal("Slack history cursor repeated");
      seen.add(next); cursor = next;
    }
    throw new Refusal("Slack history page bound reached; cursor retained");
  }
  private async pollSlack(): Promise<void> {
    const slack = new Slack(this.http, this.io.clock, { token: this.config.credential, cookie: this.config.cookie });
    for (const lane of this.d.store.lanes()) if (lane.origin?.kind === "messenger" && this.scope(lane.origin.origin) && lane.origin.origin.thread && !["done", "lost"].includes(lane.status)) {
      const o = lane.origin.origin;
      if (!(await this.ledger.list()).some(t => t.channel === o.target && t.rootTs === o.thread)) await this.ledger.record(o.target, o.thread!, o.thread!);
    }
    if (this.config.upstreamDiscovery) for (const m of await pollSlackInbound(slack, this.ledger, { selfUserId: this.config.account })) {
      // Discovery projections omit subtype/forward metadata. Use them only to find
      // roots, then authenticate/filter the complete raw messages from replies.
      if (m.ts && m.threadTs && m.user === this.config.ownerId && this.config.targets.includes(m.channel)) {
        const watched = (await this.ledger.list()).some(t => t.channel === m.channel && t.rootTs === m.threadTs);
        if (!watched) await this.ledger.record(m.channel, m.threadTs, m.threadTs);
      }
    }
    for (const channel of this.config.targets) {
      const oldest = this.state.slack[channel] ?? this.config.since!;
      let high = oldest;
      await this.slackPage(slack, "conversations.history", { channel, oldest, inclusive: false }, async m => {
        await this.slackMessage(channel, m); if (tsAfter(m.ts, high)) high = m.ts;
      });
      this.state.slack[channel] = high; this.save();
    }
    for (const t of await this.ledger.list()) {
      let high = t.seenTs;
      await this.slackPage(slack, "conversations.replies", { channel: t.channel, ts: t.rootTs, oldest: t.seenTs, inclusive: false }, async m => {
        if (tsAfter(m.ts, t.seenTs)) { await this.slackMessage(t.channel, m, t.rootTs); if (tsAfter(m.ts, high)) high = m.ts; }
      });
      await this.ledger.markSeen(t.channel, t.rootTs, high);
    }
  }
  private disconnect(): void {
    if (this.heartbeat !== undefined) this.io.timers.clearInterval(this.heartbeat); this.heartbeat = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close();
  }
  private async discordMessage(e: any, channel: string): Promise<void> {
    if (!e || !/^\d+$/.test(e.id ?? "") || e.channel_id !== channel || typeof e.content !== "string" || !e.content.trim() || e.content.length > 64_000 || e.author?.bot || e.webhook_id || e.message_snapshots?.length || e.type !== 0 && e.type !== 19) { this.reject("malformed-or-bot-or-forwarded"); return; }
    if (e.author?.id !== this.config.ownerId) { this.reject("unauthorized"); return; }
    await this.admit({ id: e.id, authorId: e.author.id, origin: this.origin(channel, e.id), text: e.content });
  }
  private async pollDiscord(): Promise<void> {
    const dc = new Discord(this.http, this.io.clock, this.config.credential);
    for (const channel of this.config.targets) {
      const after = this.state.discordAfter[channel]!;
      let before: string | undefined, finished = false;
      const messages = new Map<string, any>();
      for (let page = 0; page < 100; page++) {
        const batch = await dc.call<any>("GET", `/channels/${channel}/messages?limit=100${before ? `&before=${before}` : ""}`);
        if (!Array.isArray(batch) || batch.some(m => typeof m?.id !== "string" || !/^\d+$/.test(m.id))) throw new Refusal("malformed Discord history");
        if (!batch.length) { finished = true; break; }
        let minimum = BigInt(batch[0].id);
        for (const m of batch) { const id = BigInt(m.id); if (id < minimum) minimum = id; if (id > BigInt(after)) messages.set(m.id, m); else finished = true; }
        if (finished || batch.length < 100) { finished = true; break; }
        if (before && minimum >= BigInt(before)) throw new Refusal("Discord history pagination did not advance");
        before = minimum.toString();
      }
      if (!finished) throw new Refusal("Discord history page bound reached; cursor retained");
      let high = after;
      for (const m of [...messages.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) {
        await this.discordMessage(m, channel); if (BigInt(m.id) > BigInt(high)) high = m.id;
      }
      this.state.discordAfter[channel] = high; this.save();
    }
  }
  private reconnect(): void {
    this.disconnect(); this.reconnectAt = this.io.clock.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.reconnects++, 6));
  }
  private connect(): void {
    if (this.stopping || this.socket) return;
    const socket = this.io.openSocket(this.state.discord?.url ?? this.gateway); this.socket = socket;
    socket.onClose(() => { if (this.socket === socket) this.reconnect(); });
    socket.onMessage(raw => {
      if (this.socket !== socket || this.stopping) return;
      void this.serialize(async () => { if (this.socket !== socket || this.stopping) return; await this.gatewayMessage(raw, socket); }).catch(() => {
        this.state.issue = "gateway-event-unconfirmed"; this.save(); this.reconnect();
      });
    });
  }
  private async gatewayMessage(raw: string, socket: RunnerSocket): Promise<void> {
    const m = JSON.parse(raw);
    if (!m || typeof m.op !== "number") throw new Refusal("malformed gateway frame");
    const send = (op: number, d: unknown) => socket.send(JSON.stringify({ op, d }));
    if (m.op === 10) {
      const interval = m.d?.heartbeat_interval;
      if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 120_000) throw new Refusal("invalid gateway heartbeat");
      if (this.heartbeat !== undefined) this.io.timers.clearInterval(this.heartbeat);
      this.heartbeatAck = true;
      this.heartbeat = this.io.timers.setInterval(() => {
        if (!this.heartbeatAck) { this.reconnect(); return; }
        this.heartbeatAck = false;
        try { send(1, this.state.discord?.seq ?? null); } catch { this.reconnect(); }
      }, interval);
      const saved = this.state.discord;
      if (saved) send(6, { token: this.config.credential, session_id: saved.session, seq: saved.seq });
      else send(2, { token: this.config.credential, intents: (1 << 0) | (1 << 9) | (1 << 15), properties: { os: process.platform, browser: "dori", device: "dori" } });
      return;
    }
    if (m.op === 11) { this.heartbeatAck = true; return; }
    if (m.op === 1) { send(1, this.state.discord?.seq ?? null); return; }
    if (m.op === 7) { this.reconnect(); return; }
    if (m.op === 9) {
      // A lost resume session is recovered through independently committed REST history.
      if (m.d !== true) { delete this.state.discord; this.state.issue = "discord-history-catchup-required"; this.save(); }
      this.reconnect(); return;
    }
    if (m.op !== 0) return;
    if (!Number.isSafeInteger(m.s) || m.s < 0) throw new Refusal("dispatch sequence missing");
    if (m.t === "READY") {
      if (m.d?.user?.id !== this.config.account || m.d.user.bot !== true || !string(m.d.session_id)) throw new Refusal("gateway account mismatch");
      this.state.discord = { session: m.d.session_id, url: discordUrl(m.d.resume_gateway_url), seq: m.s }; this.reconnects = 0; this.save(); return;
    }
    if (!this.state.discord) throw new Refusal("gateway event before authenticated READY");
    if (this.state.discord.seq !== null && m.s <= this.state.discord.seq) return;
    if (m.t === "MESSAGE_CREATE") {
      const e = m.d;
      if (e?.guild_id !== this.config.workspace || !this.config.targets.includes(e?.channel_id)) this.reject("unauthorized");
      else await this.discordMessage(e, e.channel_id);
    }
    if (m.t === "RESUMED") this.reconnects = 0;
    // A sequence acknowledges only events that are durably admitted or explicitly ignored.
    this.state.discord.seq = m.s; this.save();
  }
  /** Wait for injected gateway events and admission; useful for supervised shutdown and fixtures. */
  async drained(): Promise<void> { await this.tail; }
  requestStop(): void { this.beginStop(); }
  async stop(): Promise<void> {
    if (this.closed) return;
    this.beginStop(); await this.tail;
    if (this.monitor !== undefined) this.io.timers.clearInterval(this.monitor);
    this.state.state = "stopped"; this.save(); this.lease.release(); this.closed = true;
  }
  async run(): Promise<void> {
    try {
      await this.start();
      while (!this.stopping) {
        await this.tick();
        for (let elapsed = 0; elapsed < this.config.intervalMs && !this.stopping; elapsed += 250) await this.io.clock.sleep(Math.min(250, this.config.intervalMs - elapsed));
      }
    } finally { await this.stop(); }
  }
}
