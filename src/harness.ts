import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { shq, spawnExec, type Exec } from "./process.ts";
import { Sessions, DeliveryDeferred, type SessionRuntime, type AgentStatus } from "./sessions.ts";
import { KEY_RE, Store, type HostLoad, type Lane, type Role } from "./store.ts";
import { prepareReviewSnapshot } from "./review-snapshot.ts";
import { integratePair, recoverIntegration, type Pair } from "./merge.ts";
import { checkInstance, checkRevision, recoverTaskInputs, revisionOf } from "./tasks.ts";
import { flushNotices, recordNotice } from "./notifications.ts";
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
  readonly reviewSnapshot?: typeof prepareReviewSnapshot;
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
  if (target === "lead" || target === "duty" || target === "conversation") {
    const thread = roles[target];
    if (!thread) throw new Refusal(`no ${target} thread registered (dori role ${target} <thread>)`);
    return thread;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.threadId;
  throw new Refusal(`unknown target ${target}: not a thread id, role or open lane`);
}

const READY_TO_READ: readonly AgentStatus[] = ["idle", "done", "failed", "recovery"];

/** Delivers now when the thread can read; otherwise queues it for the duty loop (busy agents are never interrupted). */
export async function send(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  if (!text.trim()) throw new Refusal("message must not be empty");
  const threadId = resolveTarget(d, target);
  const messageId = randomUUID();
  const lane = d.store.laneByThread(threadId);
  const enqueue = () => d.store.enqueue(threadId, { id: messageId, at: d.now(), from, text });
  if (lane) {
    // Closure holds this same lease across status/archive, so new instructions
    // are either durably admitted before it or refused without being queued.
    d.store.editLane(lane.key, (current) => {
      if (current.threadId !== threadId || current.status === "done" || current.status === "lost") throw new Refusal("lane changed before message admission; refresh it");
      enqueue(); return false;
    });
  } else enqueue();
  await flushInbox(d, threadId);
  return d.store.queued(threadId).some(m => m.id === messageId) ? "QUEUED" : "DELIVERED";
}

export async function flushInbox(d: Deps, threadId: string): Promise<boolean> {
  const unlock = d.store.lockInbox(threadId);
  if (!unlock) return false;
  try {
  if (d.store.queued(threadId).length === 0) return true;
  const status = await d.sessions.status(threadId);
  if (status === "gone") throw new Refusal(`thread ${threadId} is gone; queued message(s) kept in its inbox`);
  const canSteer = status === "working" && d.store.queued(threadId).some(m => m.mode === "steer") && d.sessions.steer;
  if (!READY_TO_READ.includes(status) && !(status === "working" && d.sessions.isExternalLead?.(threadId)) && !canSteer) return false;
  let batch = d.store.inboxBatch(threadId)!;
  while (batch.messages.every((m) => !m.text.trim())) {
    d.store.ackInbox(threadId, batch.messages.length);
    if (d.store.queued(threadId).length === 0) return true;
    batch = d.store.inboxBatch(threadId)!;
  }
  const queued = batch.messages;
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  const targetLane = d.store.laneByThread(threadId);
  if (targetLane && queued.some((m) => m.from !== "duty")) {
    d.store.editLane(targetLane.key, (current) => {
      // Save before submission. A crash before inbox acknowledgement may replay
      // the same accepted batch after its turn has already produced fresh READY.
      if (current.lastInstructionBatch === batch.id) return false;
      current.lastInstructionBatch = batch.id;
      if (current.status === "ready") {
        current.status = "working"; delete current.final;
        current.log.push({ at: d.now(), kind: "report", text: "new instruction supersedes prior READY evidence" });
      }
    });
  }
  try {
    if (canSteer) await d.sessions.steer!(threadId, body, batch.id);
    else await d.sessions.deliver(threadId, body, batch.id);
  }
  catch (e) { if (e instanceof DeliveryDeferred) return false; throw e; }
  const lane = d.store.laneByThread(threadId);
  if (lane && queued.some(m => m.revision)) d.store.editLane(lane.key, current => {
    for (const message of queued) {
      const instruction = current.instructions?.find(i => i.revision === message.revision);
      if (instruction?.status === "queued") instruction.status = "delivered";
    }
  });
  if (lane?.kickoffPending) {
    d.store.editLane(lane.key, (current) => {
      current.kickoffPending = false;
      if (current.status === "waiting") current.status = "working";
      current.lastActivityAt = d.now();
    });
  }
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
  if (key === "lead" || key === "duty" || key === "conversation" || d.sessions.known(key)) throw new Refusal(`lane key ${key} is reserved or already identifies a thread`);
  const unlock = d.store.lockAllocation(key);
  if (!unlock) throw new Refusal(`lane ${key} allocation is already in progress`);
  try { return await allocateLane(d, key, briefFile, opts); } finally { unlock(); }
}

async function allocateLane(d: Deps, key: string, briefFile: string, opts: { cwd?: string }): Promise<Lane> {
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${existing.threadId}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const briefText = readFileSync(briefFile, "utf8").trimEnd();
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${briefText}\n\n${footer}`);

  const threadId = await d.sessions.create(key, cwd, footer);
  await Bun.write(briefPath, `${briefText}\n\n${footer}\n\nTask instance: ${threadId}. Every ack, report, ready and done command for this task must include --instance ${threadId}. READY and reports after a pivot also require the exact --revision N.\n`);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;

  const now = d.now();
  const lane: Lane = {
    key, threadId, brief: briefPath, cwd,
    title: briefText.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "").slice(0, 160) ?? key, direction: briefText.slice(0, 1000), revision: 1,
    instructions: [{ revision: 1, text: "Initial task brief", at: now, status: "delivered" }],
    status: "working", kickoffPending: true, createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  try {
    if (await send(d, threadId, kickoff, "lead") !== "DELIVERED") throw new Refusal("kickoff queued; inspect the existing lane before retrying");
  } catch (e) {
    d.store.editLane(key, (current) => {
      if (!current.kickoffPending || current.status === "ready" || current.status === "done") return false;
      current.status = "waiting";
      current.log.push({ at: d.now(), kind: "report", text: "kickoff delivery unresolved; reconcile this session before replacement" });
    });
    throw e;
  }
  await tellLead(d, `[START ${key}] lane opened in ${threadId}`, key);
  return d.store.lane(key)!;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting", revision?: number, instance?: string): Promise<void> {
  const now = d.now();
  d.store.editLane(key, (lane) => {
    if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
    checkInstance(d, lane, instance);
    if ((revision ?? 1) !== revisionOf(lane)) throw new Refusal(`stale or missing report revision; current revision is ${revisionOf(lane)}`);
    lane.log.push({ at: now, kind: "report", text });
    lane.lastActivityAt = now; lane.nudges = 0;
    if (status) lane.status = status;
  });
  await tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key);
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[], revision?: number, instance?: string): Promise<void> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const now = d.now();
  d.store.editLane(key, (lane) => {
    if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
    checkInstance(d, lane, instance);
    const currentRevision = checkRevision(lane, revision);
    lane.status = "ready"; lane.final = { text, evidence: [...evidence], at: now, revision: currentRevision };
    lane.lastActivityAt = now; lane.log.push({ at: now, kind: "ready", text });
  });
  await tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key);
}

export async function done(d: Deps, key: string, instance?: string): Promise<void> {
  const unlockLane = d.store.lockLaneMutation(key);
  if (!unlockLane) throw new Refusal(`lane ${key} update is busy; retry after the current update`);
  let unlockInbox: (() => void) | undefined;
  try {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  checkInstance(d, lane, instance);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  if ((lane.final?.revision ?? 1) !== revisionOf(lane)) throw new Refusal("final evidence belongs to an older task revision");
  checkRevision(lane, lane.final?.revision);
  unlockInbox = d.store.lockInbox(lane.threadId);
  if (!unlockInbox) throw new Refusal(`lane ${key} delivery is busy; finish it before closing`);
  if (d.store.queued(lane.threadId).length) throw new Refusal(`lane ${key} has queued messages; deliver them before closing`);
  const st = await d.sessions.status(lane.threadId);
  if (st === "working" || st === "blocked" || st === "failed" || st === "recovery") throw new Refusal(`lane ${key} thread is ${st}; let it finish or recover first`);
  if (st !== "gone") await d.sessions.close(lane.threadId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  // Commit the completion outbox before making this key reusable. A crash leaves
  // READY locally, and the collector holds the candidate until DONE is persisted.
  recordNotice(d, { task: lane.key, instance: lane.threadId, revision: revisionOf(lane), kind: "completion", summary: lane.final!.text, decision: "없음", details: lane.final!.evidence }, `done:${lane.threadId}:${revisionOf(lane)}`, lane.log.at(-1)!.at);
  d.store.saveLane(lane);
  } finally { unlockInbox?.(); unlockLane(); }
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
  try { recoverTaskInputs(d); } catch (e) { events.push({ action: "input-recovery-failed", detail: failureDetail(e) }); }
  for (const threadId of d.store.inboxThreads()) {
    try {
      if (await flushInbox(d, threadId)) events.push({ thread: threadId, action: "flushed" });
    } catch (e) {
      // One thread's failed delivery must never kill the loop for every other thread and lane.
      if (e instanceof Refusal) events.push({ thread: threadId, action: "inbox-target-gone" });
      else events.push({ thread: threadId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const observed of d.store.lanes()) {
    if (observed.status !== "working" && observed.status !== "waiting") continue;
    try {
      const st = await d.sessions.status(observed.threadId);
      const now = d.now();
      let action: "lost" | "failed" | "recovery" | "nudge" | "escalate" | undefined;
      let idleMin = 0;
      const lane = d.store.editLane(observed.key, (current) => {
        if (current.threadId !== observed.threadId || (current.status !== "working" && current.status !== "waiting")) return false;
        if (st === "gone") {
          current.status = "lost";
          current.log.push({ at: now, kind: "lost", text: "thread disappeared without READY" });
          action = "lost"; return;
        }
        if (st === "working") { current.lastActivityAt = now; return; }
        if (st === "failed" || st === "recovery") {
          if (current.status === "waiting") return false;
          current.status = "waiting";
          current.log.push({ at: now, kind: "report", text: st === "failed" ? "Codex turn failed; waiting for recovery instructions" : "Codex turn outcome is unconfirmed; waiting for recovery instructions" });
          action = st; return;
        }
        if (current.status === "waiting" || st === "blocked" || st === "unknown") return false;
        idleMin = (now - current.lastActivityAt) / 60_000;
        const due = NUDGE_MINUTES[current.nudges];
        if (due === undefined || idleMin < due) return false;
        current.nudges += 1;
        current.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
        action = current.nudges < NUDGE_MINUTES.length ? "nudge" : "escalate";
      });
      if (action === "lost") {
        await tellLead(d, `[LOST ${lane.key}] thread ${lane.threadId} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
      } else if (action === "failed") {
        await tellLead(d, `[FAILED ${lane.key}] Codex turn failed; lane kept open for recovery`, "duty");
        events.push({ lane: lane.key, action: "failed" });
      } else if (action === "recovery") {
        await tellLead(d, `[RECOVERY ${lane.key}] latest turn outcome is unconfirmed; lane kept open`, "duty");
        events.push({ lane: lane.key, action: "recovery" });
      } else if (action === "nudge") {
        await send(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else if (action === "escalate") {
        await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      events.push({ lane: observed.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  if (d.store.roles().conversation) {
    try {
      for (const lane of d.store.lanes()) if (lane.status === "done" && lane.final && (lane.final.revision ?? 1) === revisionOf(lane)) {
        recordNotice(d, { task: lane.key, instance: lane.threadId, revision: revisionOf(lane), kind: "completion", summary: lane.final.text, decision: "없음", details: lane.final.evidence }, `done:${lane.threadId}:${revisionOf(lane)}`, lane.log.findLast(l => l.kind === "done")?.at ?? lane.final.at);
      }
      await flushNotices(d);
    } catch (e) { events.push({ action: "notification-pending", detail: failureDetail(e) }); }
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

async function reviewTarget(d: Deps, pr: PrRef): Promise<Pair> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid,baseRefOid,baseRefName,state,isDraft"]));
  if (!/^[0-9a-f]{40}$/.test(out.headRefOid) || !/^[0-9a-f]{40}$/.test(out.baseRefOid) || typeof out.baseRefName !== "string" || !out.baseRefName || typeof out.state !== "string" || typeof out.isDraft !== "boolean") throw new Refusal("GitHub returned no complete head/base/branch identity; review unconfirmed");
  return { head: out.headRefOid, base: out.baseRefOid, baseBranch: out.baseRefName, state: out.state, draft: out.isDraft };
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(d: Deps, prId: string, model?: string): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string; baseSha: string; reportPath: string }> {
  const pr = parsePr(prId);
  const { head: sha, base: baseSha, baseBranch } = await reviewTarget(d, pr);
  const snapshot = await (d.reviewSnapshot ?? prepareReviewSnapshot)(d.store.root, process.cwd(), pr.id, sha, baseSha);
  const text = prompt("review.md", { pr: pr.id, sha, base: baseSha, source: snapshot.cwd, diff: snapshot.diffPath, metadata: snapshot.metadataPath });
  const output = await d.sessions.review(text, snapshot.cwd, model);
  writeFileSync(snapshot.reportPath, output + "\n", { mode: 0o600 });
  const current = await reviewTarget(d, pr);
  if (current.head !== sha || current.base !== baseSha || current.baseBranch !== baseBranch) throw new Refusal("PR head or base changed during review; no receipt written");
  const verdicts = [...output.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
  const verdict = last[1] as "CLEAR" | "BLOCK";
  d.store.saveReceipt({ pr: pr.id, sha, baseSha, baseBranch, verdict, model: model ?? "default", at: d.now(), summary: output.trim().slice(-4000), reportPath: snapshot.reportPath });
  return { verdict, sha, baseSha, reportPath: snapshot.reportPath };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean; method?: "merge" | "squash" | "rebase" } = {}): Promise<string> {
  const pr = parsePr(prId);
  if (opts.method && opts.method !== "merge") throw new Refusal("MERGE_REFUSED only merge commits support reviewed-pair integration");
  const unlock = d.store.lockMerge(pr.id);
  if (!unlock) throw new Refusal("MERGE_REFUSED integration is already in progress");
  try {
  const pair = await reviewTarget(d, pr);
  const readTarget = () => reviewTarget(d, pr);
  const previous = await recoverIntegration(d, pr, pair, readTarget);
  if (previous) return previous;
  const { head: sha, base, baseBranch } = pair;
  const refused = await gateRefusal(d, pr, sha, base, baseBranch);
  if (refused) {
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  const current = await reviewTarget(d, pr);
  if (current.head !== sha || current.base !== base || current.baseBranch !== baseBranch || current.state !== "OPEN" || current.draft) throw new Refusal("MERGE_REFUSED head, base or PR state changed while checking");
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  return integratePair(d, pr, pair, readTarget);
  } finally { unlock(); }
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string, base: string, baseBranch: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori-codex review ${pr.id})`];
  if (receipt.pr !== pr.id || receipt.sha !== sha || receipt.baseSha !== base || receipt.baseBranch !== baseBranch) return ["no_receipt", "target repository or base changed; review this head/base pair again"];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checks: Check[] = [];
  for (const endpoint of [`repos/${pr.repo}/commits/${sha}/check-runs?filter=latest&per_page=100`, `repos/${pr.repo}/commits/${sha}/status?per_page=100`]) {
    const r = await d.exec("gh", ["api", endpoint, "--paginate", "--slurp"]);
    if (r.code !== 0) return ["checks_red", "check command failed; status is unconfirmed"];
    const pages = JSON.parse(r.stdout);
    if (!Array.isArray(pages)) return ["checks_red", "invalid check response; status is unconfirmed"];
    for (const page of pages) {
      for (const c of page.check_runs ?? []) checks.push({ name: c.name, bucket: c.status !== "completed" ? "pending" : c.conclusion === "success" ? "pass" : c.conclusion === "skipped" || c.conclusion === "neutral" ? "skipping" : "fail" });
      for (const s of page.statuses ?? []) checks.push({ name: s.context, bucket: s.state === "success" ? "pass" : s.state === "pending" ? "pending" : "fail" });
    }
  }
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
