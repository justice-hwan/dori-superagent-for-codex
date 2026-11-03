import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { shq, spawnExec, type Exec } from "./process.ts";
import { Sessions, type SessionRuntime, type AgentStatus } from "./sessions.ts";
import { KEY_RE, Store, type HostLoad, type Lane, type Role } from "./store.ts";
type MergeOutcome = "merged" | "no_receipt" | "review_block" | "no_checks" | "checks_red" | "checks_all_skipped";

export { KEY_RE };

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  readonly sessions: SessionRuntime;
  readonly exec: Exec;
  readonly now: () => number;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  return {
    store,
    sessions: new Sessions(store.root),
    exec: spawnExec,
    now: Date.now,
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
  };
};

export class Refusal extends Error {}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- thread messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  if (d.sessions.known(target)) return target;
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const thread = roles[target];
    if (!thread) throw new Refusal(`no ${target} thread registered (dori role ${target} <thread>)`);
    return thread;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.threadId;
  throw new Refusal(`unknown target ${target}: not a thread id, role or open lane`);
}

const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

/** Delivers now when the thread can read; otherwise queues it for the duty loop (busy agents are never interrupted). */
export async function send(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const threadId = resolveTarget(d, target);
  d.store.enqueue(threadId, { at: d.now(), from, text });
  return (await flushInbox(d, threadId)) ? "DELIVERED" : "QUEUED";
}

export async function flushInbox(d: Deps, threadId: string): Promise<boolean> {
  const unlock = d.store.lockInbox(threadId);
  if (!unlock) return false;
  try {
  if (d.store.queued(threadId).length === 0) return true;
  const status = await d.sessions.status(threadId);
  if (status === "gone") throw new Refusal(`thread ${threadId} is gone; queued message(s) kept in its inbox`);
  if (!READY_TO_READ.includes(status)) return false;
  const batch = d.store.inboxBatch(threadId)!;
  const queued = batch.messages;
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  await d.sessions.deliver(threadId, body, batch.id);
  d.store.ackInbox(threadId, queued.length);
  return true;
  } finally { unlock(); }
}

export async function tellLead(d: Deps, text: string, from: string): Promise<void> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead thread registered; message kept only in the lane log\n`);
    return;
  }
  await send(d, "lead", text, from);
}

// ---------- lanes ----------

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${existing.threadId}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  const threadId = await d.sessions.create(key, cwd, footer);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;

  const now = d.now();
  const lane: Lane = {
    key, threadId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  try {
    await d.sessions.deliver(threadId, kickoff);
  } catch (e) {
    lane.status = "lost";
    lane.log.push({ at: d.now(), kind: "lost", text: "Codex turn failed to start" });
    d.store.saveLane(lane);
    await d.sessions.close(threadId).catch(() => {});
    throw e;
  }
  await tellLead(d, `[START ${key}] lane opened in ${threadId}`, key);
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<void> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  await tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key);
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<void> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  await tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key);
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.sessions.status(lane.threadId);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} thread is ${st}; let it finish first`);
  if (st !== "gone") await d.sessions.close(lane.threadId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; thread?: string; action: string; detail?: string };

/** A short one-line reason. A RPC error message carries the whole argv (the queued text), so use Codex's own output. */
function failureDetail(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** One proactive pass: flush inboxes of threads that became idle, nudge silent lanes, escalate, detect lost threads. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const threadId of d.store.inboxThreads()) {
    try {
      if (await flushInbox(d, threadId)) events.push({ thread: threadId, action: "flushed" });
    } catch (e) {
      // One thread's failed delivery must never kill the loop for every other thread and lane.
      if (e instanceof Refusal) events.push({ thread: threadId, action: "inbox-target-gone" });
      else events.push({ thread: threadId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    try {
      const st = await d.sessions.status(lane.threadId);
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "thread disappeared without READY" });
        d.store.saveLane(lane);
        await tellLead(d, `[LOST ${lane.key}] thread ${lane.threadId} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
        continue;
      }
      if (lane.status === "waiting" || st === "blocked") continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await send(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  return events;
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(d: Deps, prId: string, model?: string): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  const output = await d.sessions.review(text, process.cwd(), model);
  const verdicts = [...output.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
  const verdict = last[1] as "CLEAR" | "BLOCK";
  d.store.saveReceipt({ pr: pr.id, sha, verdict, model: model ?? "default", at: d.now(), summary: output.trim().slice(-4000) });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
