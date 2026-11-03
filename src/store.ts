import { mkdirSync, readdirSync, existsSync, appendFileSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { acquireFileLease } from "./lock.ts";
import { homedir } from "node:os";
import { join } from "node:path";

export type LaneStatus = "working" | "waiting" | "ready" | "done" | "lost";

export type Lane = {
  key: string;
  threadId: string;
    brief: string;
  cwd: string;
  status: LaneStatus;
  createdAt: number;
  lastActivityAt: number;
  nudges: number;
  kickoffPending?: boolean;
  lastInstructionBatch?: string;
  final?: { text: string; evidence: string[]; at: number };
  log: { at: number; kind: "start" | "report" | "ready" | "nudge" | "done" | "lost"; text: string }[];
};

export type Role = "lead" | "duty";

export type QueuedMessage = { at: number; from: string; text: string };
export type InboxBatch = { id: string; offset: number; messages: QueuedMessage[] };

export type ReviewReceipt = {
  pr: string;
  sha: string;
  baseSha: string;
  baseBranch?: string;
  verdict: "CLEAR" | "BLOCK";
  model: string;
  at: number;
  summary: string;
  reportPath?: string;
};

export type PreparedMerge = { pr: string; repo: string; baseBranch: string; head: string; base: string; tree: string; commit: string; confirmedAt?: number; rejected?: boolean };

export type ItemStatus = "open" | "running" | "done" | "dropped";

/** One backlog entry. Its id is the lane key the hourly loop starts it under. */
export type Item = {
  id: string;
  title: string;
  brief: string;
  cwd: string;
  priority: number;
  status: ItemStatus;
  decision?: string;
  askedAt?: number;
  remindedAt?: number;
  attempts: number;
  startFailures?: number;
  source?: string;
  createdAt: number;
  updatedAt: number;
  log: { at: number; kind: "add" | "start" | "reopen" | "done" | "drop" | "ask" | "remind" | "decide"; text: string }[];
};

export type HostLoad = { load1: number; cores: number; memFreePct: number };

export type LoopRun = {
  at: number;
  skipped?: string;
  status?: {
    lanes: number;
    maxLanes: number;
    adhoc: string[];
    items: { open: number; decide: number; running: number };
    host: HostLoad;
  };
  synced: string[];
  findings: string[];
  started: string[];
  held: string[];
  asked: string[];
};

export const KEEP_RUNS = 168;
export const KEY_RE = /^[a-z][a-z0-9-]{1,40}$/;

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store {
  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori-codex")) {
    for (const d of ["lanes", "inbox", "briefs", "receipts", "merges", "backlog", "loop/runs", "sessions", "duty"]) mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
  }

  private readJson<T>(path: string): T | undefined {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  }

  lane(key: string): Lane | undefined {
    return this.readJson<Lane>(join(this.root, "lanes", `${checkedId(key)}.json`));
  }

  saveLane(lane: Lane): void {
    checkedId(lane.key);
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), lane);
  }

  lockAllocation(key: string): (() => void) | undefined {
    checkedId(key);
    return acquireFileLease(join(this.root, "lanes", `${key}.allocation.lock`))?.release;
  }

  lockLaneMutation(key: string): (() => void) | undefined {
    checkedId(key);
    return acquireFileLease(join(this.root, "lanes", `${key}.mutation.lock`))?.release;
  }

  editLane(key: string, edit: (lane: Lane) => void | false): Lane {
    checkedId(key);
    const unlock = this.lockLaneMutation(key);
    if (!unlock) throw new Error(`lane ${key} update is busy; retry after the current update`);
    try {
      const lane = this.lane(key);
      if (!lane) throw new Error(`no lane ${key}`);
      if (edit(lane) !== false) this.saveLane(lane);
      return lane;
    } finally { unlock(); }
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Lane>(join(this.root, "lanes", f)))
      .filter((l): l is Lane => l !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneByThread(threadId: string): Lane | undefined {
    return this.lanes().find((l) => l.threadId === threadId && l.status !== "done");
  }

  roles(): Partial<Record<Role, string>> {
    return this.readJson(join(this.root, "roles.json")) ?? {};
  }

  setRole(role: Role, threadId: string): void {
    this.writeJson(join(this.root, "roles.json"), { ...this.roles(), [role]: threadId });
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  private inboxPath(threadId: string): string {
    if (!/^[a-zA-Z0-9:_-]+$/.test(threadId)) throw new Error("invalid thread id");
    return join(this.root, "inbox", `${encodeURIComponent(threadId)}.jsonl`);
  }

  enqueue(threadId: string, msg: QueuedMessage): void {
    appendFileSync(this.inboxPath(threadId), JSON.stringify(msg) + "\n", { mode: 0o600 });
  }

  queued(threadId: string): QueuedMessage[] {
    const p = this.inboxPath(threadId);
    if (!existsSync(p)) return [];
    const cursor = this.readJson<number>(p + ".cursor") ?? 0;
    return readFileSync(p, "utf8").split("\n").filter(Boolean).slice(cursor).map((l) => JSON.parse(l) as QueuedMessage);
  }

  clearInbox(threadId: string): void {
    this.ackInbox(threadId, this.queued(threadId).length);
  }

  inboxBatch(threadId: string): InboxBatch | undefined {
    const p = this.inboxPath(threadId);
    const saved = this.readJson<InboxBatch>(p + ".batch");
    if (saved) return saved;
    const messages = this.queued(threadId);
    if (!messages.length) return undefined;
    const batch = { id: randomUUID(), offset: this.readJson<number>(p + ".cursor") ?? 0, messages };
    this.writeJson(p + ".batch", batch);
    return batch;
  }

  /** Acknowledge only the submitted batch. Concurrent appends never get truncated. */
  ackInbox(threadId: string, count: number): void {
    const p = this.inboxPath(threadId) + ".cursor";
    const cursor = this.readJson<number>(p) ?? 0;
    const batchPath = this.inboxPath(threadId) + ".batch";
    const batch = this.readJson<InboxBatch>(batchPath);
    this.writeJson(p, Math.max(cursor, (batch?.offset ?? cursor) + count));
    if (batch) unlinkSync(batchPath);
  }

  /** Serialize submissions across CLI processes and duty ticks, with dead-owner recovery. */
  lockInbox(threadId: string): (() => void) | undefined {
    return acquireFileLease(this.inboxPath(threadId) + ".lock")?.release;
  }

  inboxThreads(): string[] {
    return readdirSync(join(this.root, "inbox"))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => decodeURIComponent(f.slice(0, -".jsonl".length)))
      .filter((p) => this.queued(p).length > 0);
  }

  private receiptPath(pr: string, sha: string): string {
    return join(this.root, "receipts", createHash("sha256").update(`${pr}\0${sha}`).digest("hex") + ".json");
  }

  saveReceipt(r: ReviewReceipt): void {
    this.writeJson(this.receiptPath(r.pr, r.sha), r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.readJson(this.receiptPath(pr, sha));
  }

  private mergePath(pr: string): string {
    return join(this.root, "merges", createHash("sha256").update(pr).digest("hex") + ".json");
  }
  mergeAttempt(pr: string): PreparedMerge | undefined { return this.readJson(this.mergePath(pr)); }
  saveMergeAttempt(attempt: PreparedMerge): void { this.writeJson(this.mergePath(attempt.pr), attempt); }
  lockMerge(pr: string): (() => void) | undefined { return acquireFileLease(this.mergePath(pr) + ".lock")?.release; }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return this.readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    this.writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  lockItem(id: string): (() => void) | undefined {
    return acquireFileLease(join(this.root, "backlog", `${checkedId(id)}.mutation.lock`))?.release;
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return this.readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    this.writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return this.readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    this.writeJson(join(dir, name), run);
    this.writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs")).filter((f) => f.endsWith(".json")).sort();
  }
}
