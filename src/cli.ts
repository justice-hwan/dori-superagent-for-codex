#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultDeps, resolveTarget, done, dutyTick, mergeGate, ready, Refusal, report, review, send, startLane, ROLES, type Deps,
} from "./harness.ts";
import { Sessions, socketPath } from "./sessions.ts";
import { ensureRuntime } from "./daemon.ts";
import { serve } from "./runtime.ts";
import { checkUpstream } from "./upstream.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import type { Role } from "./store.ts";
import { MessengerJournal, sendMessenger, type MessengerConfig, type MessengerOrigin } from "./messenger.ts";
import { connection, readConnection, type Connection } from "./connection.ts";
import { acknowledge, findTasks, pivot, taskDocument, taskFor, revisionOf } from "./tasks.ts";
import { acknowledgeNotice, deliverExternalNotice, flushNotices, notices, recordNotice } from "./notifications.ts";
import { MessengerRunner, readRunnerConfig, requestRunnerStop, runnerExample, runnerStatus } from "./messenger-runner.ts";

const USAGE = `dori-codex - a local multi-session harness on Codex app-server

  dori-codex up [--cwd DIR]                         start local runtime + lead/duty threads (no model turn)
  dori-codex up --connect ws+unix:///PATH --lead THREAD   attach existing loaded chat as external lead
  dori-codex up --split                            keep this chat as conversation, allocate internal work lead
  dori-codex task find [TEXT] | show KEY | document KEY
  dori-codex pivot KEY --text T [--expected-revision N]   revise and steer running owned work
  dori-codex ack KEY --instance THREAD --revision N                  worker acknowledges current direction
  dori-codex messenger status | bind KEY --origin FILE | reply KEY --config FILE --id ID --text T
  dori-codex messenger config example PLATFORM | check --config /absolute/FILE
  dori-codex messenger start --config /absolute/FILE    foreground inbound + automatic completion replies
  dori-codex messenger stop RUNNER_ID                   cooperative stop (no shared-runtime signals)
  dori-codex messenger report NOTICE --config FILE | reconcile ID --delivered true|false [--message ID]
  dori-codex notifications list | flush | ack ID    compact durable conversation reports
  dori-codex notify KEY --kind decision|failure --text T [--decision Q]
  dori-codex up --owned                            explicitly select owned stdio mode while stopped
  dori-codex role <lead|duty|conversation> [THREAD]                register an existing Dori-owned thread
  dori-codex start <key> --brief FILE [--cwd DIR] [--origin FILE]   start a Codex thread from a brief + lane rules
  dori-codex report <key> [--instance THREAD] [--revision N] --text T [--status working|waiting]
  dori-codex ready <key> [--instance THREAD] [--revision N] --text T --evidence LINK [--evidence LINK ...]
  dori-codex send <lead|duty|key|thread> --text T     deliver now, or queue until the thread is idle
  dori-codex duty stop [--text WHY] | resume | status   pause/resume the duty loop
  dori-codex duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori-codex loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori-codex loop stop [--text WHY] | resume | status   kill switch and last run
  dori-codex backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori-codex backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  dori-codex backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori-codex review <owner/repo#N> [--model M]      fresh Codex reviewer at the exact head -> receipt
  dori-codex merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> merge commit
  dori-codex done <key> [--instance THREAD]          lead closes a READY lane
  dori-codex status                            local registry (works while stopped)
  dori-codex read <lead|key|thread>             latest assistant output
  dori-codex interrupt <lead|key|thread>        interrupt an owned turn
  dori-codex reconcile TARGET --delivered true|false  resolve a delivery after inspecting history
  dori-codex requests                          pending approval / input requests
  dori-codex requests answer ID --json FILE    answer one pending request explicitly
  dori-codex doctor                            runtime + sign-in status (no credentials)
  dori-codex down                              interrupt owned turns and stop local runtime
  dori-codex upstream check [--repo DIR]        fetch and list unintegrated upstream commits

--text may be omitted to read the message from stdin.`;


type Args = { pos: string[]; flags: Map<string, string[]> };

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

async function textOf(a: Args): Promise<string> {
  const t = one(a, "text");
  if (t !== undefined) return t;
  if (process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  return (await Bun.stdin.text()).trim();
}

async function up(d: Deps, cwd: string, autoLoop: boolean, selected: Connection, split = false): Promise<void> {
  const lease = d.store.lockRoles();
  if (!lease) throw new Refusal("role startup or registration is busy; retry after it finishes");
  try {
  const currentLead = d.store.roles().lead;
  if (selected.mode === "shared" && currentLead && currentLead !== selected.lead && d.store.roles().conversation !== selected.lead) throw new Refusal("lead already registered; replacement refused (use a separate DORI_HOME)");
  if (split && selected.mode !== "shared") throw new Refusal("--split requires an explicitly attached existing conversation");
  if (selected.mode === "owned" && d.store.roles().conversation) throw new Refusal("split conversation registered; use its shared connection or a separate DORI_HOME");
  if (selected.mode === "owned" && currentLead && d.sessions.isExternalLead?.(currentLead)) throw new Refusal("external lead registered; use a separate DORI_HOME for owned mode");
  await ensureRuntime(d.store.root, autoLoop, selected);
  if (selected.mode === "shared") {
    await new Sessions(d.store.root).call("registerExternalLead", { threadId: selected.lead });
    if (split || d.store.roles().conversation) {
      const roles = d.store.roles();
      if (roles.conversation && roles.conversation !== selected.lead) throw new Refusal("conversation replacement refused");
      let workLead = roles.lead;
      if (!workLead || workLead === selected.lead || await d.sessions.status(workLead) === "gone") {
        const instructions = readFileSync(join(import.meta.dir, "..", "prompts", "work-lead.md"), "utf8").replaceAll("{{dori}}", d.doriCmd);
        workLead = await d.sessions.create("업무 lead", cwd, instructions);
      }
      lease.setMany({ conversation: selected.lead, lead: workLead });
      console.log(`UP conversation=${selected.lead} lead=${workLead} duty=code mode=shared split=true home=${d.store.root}`);
    } else {
      lease.set("lead", selected.lead);
      console.log(`UP lead=${selected.lead} duty=code mode=shared home=${d.store.root}`);
    }
    return;
  }
  for (const role of ROLES) {
    const old = d.store.roles()[role];
    if (old && await d.sessions.status(old) !== "gone") continue;
    const instructions = readFileSync(join(import.meta.dir, "..", "prompts", `${role}.md`), "utf8").replaceAll("{{dori}}", d.doriCmd);
    lease.set(role, await d.sessions.create(role, cwd, instructions));
  }
  console.log(`UP lead=${d.store.roles().lead} duty=${d.store.roles().duty} home=${d.store.root}`);
  } finally { lease.release(); }
}

function status(d: Deps): void {
  const roles = d.store.roles();
  console.log(`conversation=${roles.conversation ?? "-"} lead=${roles.lead ?? "-"} duty=${roles.duty ?? "-"} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(`${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.threadId.padEnd(8)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`);
  }
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  const [cmd, x] = a.pos;
  switch (cmd) {
    case "upstream": {
      if (x !== "check") throw new Refusal("use upstream check");
      console.log(JSON.stringify(await checkUpstream(resolve(one(a, "repo") ?? join(import.meta.dir, ".."))), null, 2));
      return 0;
    }
    case "serve": {
      return await serve(d.store.root, async () => {
        await dutyTick(d);
        if (process.env["DORI_AUTO_LOOP"] === "1") await loopTick(d);
      });
    }
    case "down": {
      const runtime = new Sessions(d.store.root);
      await runtime.call("shutdown");
      for (let n = 0; n < 100; n++) {
        await Bun.sleep(100);
        if (!existsSync(socketPath(d.store.root))) {
          if (existsSync(join(d.store.root, "runtime.lock"))) throw new Refusal("runtime socket disappeared but ownership remains; shutdown unconfirmed");
          console.log("DOWN"); return 0;
        }
        const health = await runtime.call<{ shutdownError?: string }>("health");
        if (health.shutdownError) throw new Refusal(`shutdown unconfirmed: ${health.shutdownError}`);
      }
      throw new Refusal("runtime is still stopping; inspect before retrying");
    }
    case "doctor": {
      const r = new Sessions(d.store.root);
      console.log(JSON.stringify({ runtime: await r.call("health"), account: await r.call("account") })); return 0;
    }
    case "read": {
      const id = resolveTarget(d, need(x, "target"));
      const state = new Sessions(d.store.root).snapshot(id) as { output?: string } | undefined;
      console.log(state?.output ?? ""); return 0;
    }
    case "interrupt": {
      const id = resolveTarget(d, need(x, "target"));
      await new Sessions(d.store.root).call("interrupt", { threadId: id }); console.log(`INTERRUPTED ${x}`); return 0;
    }
    case "reconcile": {
      const id = resolveTarget(d, need(x, "target"));
      const value = one(a, "delivered");
      if (value !== "true" && value !== "false") throw new Refusal("inspect the Codex history, then give --delivered true or --delivered false explicitly");
      await new Sessions(d.store.root).call("reconcile", { threadId: id, delivered: value === "true" });
      console.log(`RECONCILED ${x} delivered=${value}`); return 0;
    }
    case "requests": {
      const runtime = new Sessions(d.store.root);
      if (x === "answer") {
        const id = need(a.pos[2], "request id");
        const file = need(one(a, "json"), "--json FILE containing the exact response object");
        const result = JSON.parse(readFileSync(file, "utf8"));
        await runtime.call("answer", { id, result }); console.log(`ANSWERED ${id}`);
      } else if (x === undefined) console.log(JSON.stringify(await runtime.call("requests"), null, 2));
      else throw new Refusal("use requests, or requests answer <id> --json FILE");
      return 0;
    }
    case "up": {
      const endpoint = one(a, "connect"), lead = one(a, "lead"), owned = one(a, "owned");
      if ((endpoint && !lead) || (lead && !endpoint) || (owned && (endpoint || lead))) throw new Refusal("use --connect ENDPOINT --lead THREAD together, or --owned");
      const selected = endpoint ? connection({ mode: "shared", endpoint, lead }) : owned ? connection({ mode: "owned" }) : readConnection(d.store.root);
      await up(d, resolve(one(a, "cwd") ?? process.cwd()), one(a, "auto-loop") === "true", selected, one(a, "split") === "true");
      return 0;
    }
    case "role": {
      const role = need(x, "role") as Role;
      if (![...ROLES, "conversation"].includes(role)) throw new Refusal(`role must be one of ${[...ROLES, "conversation"].join(", ")}`);
      const thread = need(a.pos[2], "thread id");
      const selected = readConnection(d.store.root);
      if (selected.mode === "shared" && (role === "lead" || thread === selected.lead)) throw new Refusal("external lead role is fixed by the shared connection; replacement refused");
      if (!d.sessions.known(thread)) throw new Refusal("role must refer to a Dori-owned thread");
      if (role === "conversation" && !d.sessions.isExternalLead?.(thread)) throw new Refusal("conversation must be the protected attached chat");
      if (role === "lead" && d.store.roles().conversation === thread) throw new Refusal("work lead must differ from the conversation");
      d.store.setRole(role, thread);
      console.log(`ROLE ${role}=${thread}`);
      return 0;
    }
    case "start": {
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"),
        origin: one(a, "origin") ? JSON.parse(readFileSync(one(a, "origin")!, "utf8")) : undefined,
      });
      console.log(`STARTED ${lane.key} thread=${lane.threadId} brief=${lane.brief}`);
      return 0;
    }
    case "messenger": {
      if (x === "config") {
        if (a.pos[2] === "example") console.log(JSON.stringify(runnerExample(need(a.pos[3], "platform")), null, 2));
        else if (a.pos[2] === "check") {
          const c = readRunnerConfig(need(one(a, "config"), "--config FILE"));
          console.log(c.enabled ? `CONFIG_OK ${c.platform} (local validation only; no provider IO)` : "MESSENGER_DISABLED");
        } else throw new Refusal("use messenger config example PLATFORM or check --config FILE");
        return 0;
      }
      if (x === "start") {
        const config = readRunnerConfig(need(one(a, "config"), "--config FILE"));
        if (!config.enabled) { console.log("MESSENGER_DISABLED"); return 0; }
        const runner = new MessengerRunner(d, config);
        const stop = () => { runner.requestStop(); };
        process.on("SIGINT", stop); process.on("SIGTERM", stop);
        try { console.log(`MESSENGER_STARTING ${config.platform} id=${runner.state.id}`); await runner.run(); }
        finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
        return 0;
      }
      if (x === "stop") { requestRunnerStop(d.store.root, need(a.pos[2], "runner ID")); console.log("MESSENGER_STOP_REQUESTED (wait for status stopped)"); return 0; }
      const journal = new MessengerJournal(d.store.root);
      if (x === undefined || x === "status") { console.log(JSON.stringify({ runners: runnerStatus(d.store.root), bindings: journal.bindings(), inbound: journal.inbound(), outgoing: journal.outgoing() }, null, 2)); return 0; }
      if (x === "bind") {
        const lane = taskFor(d, need(a.pos[2], "task selector")), origin = JSON.parse(readFileSync(need(one(a, "origin"), "--origin FILE"), "utf8"));
        // New tasks already capture their route at allocation. This command can
        // confirm that binding, never retarget a task after admission.
        journal.bindTask(lane.threadId, origin); console.log(`BOUND ${lane.key}`); return 0;
      }
      if (x === "reconcile") { const delivered = one(a, "delivered"); if (delivered !== "true" && delivered !== "false") throw new Refusal("inspect platform history then supply --delivered true|false"); journal.reconcile(need(a.pos[2], "delivery id"), delivered === "true", one(a, "message")); console.log("RECONCILED"); return 0; }
      if (x === "report" || x === "reply") {
        // Read explicit configuration only at the user's requested send command.
        const config = JSON.parse(readFileSync(need(one(a, "config"), "--config FILE"), "utf8")) as MessengerConfig & { account: string; workspace?: string };
        if (x === "report") console.log(`SENT ${await deliverExternalNotice(d, need(a.pos[2], "notice id"), config)}`);
        else {
          const lane = taskFor(d, need(a.pos[2], "task selector")), origin = journal.origin(lane.threadId), text = await textOf(a);
          if (!origin || config.platform !== origin.platform || config.account !== origin.account || config.workspace !== origin.workspace) throw new Refusal("configured messenger does not match the captured task origin");
          const receipt = await journal.reply(lane.threadId, need(one(a, "id"), "--id stable-delivery-id"), text, route => sendMessenger({ ...config, ...route, text }));
          console.log(`SENT ${receipt.messageId}`);
        }
        return 0;
      }
      throw new Refusal("use messenger config, start --config FILE, stop RUNNER_ID, status, bind KEY --origin FILE, reply KEY --config FILE --id ID, report NOTICE --config FILE, reconcile ID");
    }
    case "task": {
      if (x === "find" || x === "list" || x === undefined) console.log(JSON.stringify(findTasks(d, a.pos.slice(2).join(" ")).map(l => ({ key: l.key, title: l.title, threadId: l.threadId, status: l.status, revision: revisionOf(l), direction: l.direction, latestInstruction: l.instructions?.at(-1) })), null, 2));
      else if (x === "show") console.log(JSON.stringify(taskFor(d, need(a.pos[2], "task selector")), null, 2));
      else if (x === "document") console.log(taskDocument(taskFor(d, need(a.pos[2], "task selector"), true)));
      else throw new Refusal("use task find [TEXT], show KEY or document KEY");
      return 0;
    }
    case "pivot": {
      const lane = await pivot(d, need(x, "task selector"), await textOf(a), one(a, "expected-revision") === undefined ? undefined : Number(one(a, "expected-revision")));
      console.log(`PIVOT ${lane.key} revision=${revisionOf(lane)} state=${lane.instructions?.at(-1)?.status}`); return 0;
    }
    case "ack": {
      const lane = acknowledge(d, need(x, "task key"), Number(need(one(a, "revision"), "--revision")), one(a, "instance"));
      console.log(`ACK ${lane.key} revision=${revisionOf(lane)}`); return 0;
    }
    case "notify": {
      const lane = taskFor(d, need(x, "task selector")), kind = one(a, "kind");
      if (kind !== "decision" && kind !== "failure") throw new Refusal("notify --kind must be decision or failure; verified completions are collected from done");
      recordNotice(d, { task: lane.key, instance: lane.threadId, revision: revisionOf(lane), kind, summary: await textOf(a), decision: one(a, "decision") ?? "", details: a.flags.get("evidence") ?? [] });
      await flushNotices(d); console.log(`NOTIFIED ${lane.key} (submission and lead acknowledgement are separate)`); return 0;
    }
    case "notifications": {
      if (x === "flush") { console.log(await flushNotices(d, true) ? "SUBMITTED" : "QUEUED"); }
      else if (x === "ack") { acknowledgeNotice(d, need(a.pos[2], "batch or notice id")); console.log("ACKNOWLEDGED"); }
      else if (x === undefined || x === "list") console.log(JSON.stringify(notices(d), null, 2));
      else throw new Refusal("use notifications list, flush or ack ID");
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined, one(a, "revision") === undefined ? undefined : Number(one(a, "revision")), one(a, "instance"));
      console.log(`REPORTED ${x}`);
      return 0;
    }
    case "ready":
      await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? [], one(a, "revision") === undefined ? undefined : Number(one(a, "revision")), one(a, "instance"));
      console.log(`READY ${x}`);
      return 0;
    case "send":
      console.log(`${await send(d, need(x, "target"), await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli")} ${x}`);
      return 0;
    case "duty": {
      if (x === "stop") { d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand", "duty"); console.log("DUTY STOPPED"); return 0; }
      if (x === "resume") { d.store.clearStop("duty"); console.log("DUTY RESUMED"); return 0; }
      if (x === "status") { const stop = d.store.stop("duty"); console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)"); return 0; }
      if (x !== undefined) throw new Refusal(`unknown duty command ${x}`);
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      if (!Number.isFinite(interval) || interval <= 0) throw new Refusal("--interval must be positive");
      do {
        for (const e of await dutyTick(d)) console.log(`DUTY ${[e.lane ?? e.thread, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
        if (one(a, "once")) break;
        await Bun.sleep(interval);
      } while (true);
      return 0;
    }
    case "loop": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand");
        console.log("LOOP STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop();
        console.log("LOOP RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop();
        const last = d.store.lastRun();
        console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)");
        console.log(last ? summary(last) : "no run yet");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown loop command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? String(HOUR / 1000)) * 1000;
      const opts = {
        interval,
        maxLanes: Number(one(a, "max-lanes") ?? process.env["DORI_MAX_LANES"] ?? "3"),
        maxStarts: Number(one(a, "max-starts") ?? process.env["DORI_MAX_STARTS"] ?? "2"),
        force: one(a, "force") === "true",
        ...(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"] ? { maxLoad: Number(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"]) } : {}),
      };
      const count = (n: number): boolean => Number.isInteger(n) && n >= 0;
      if (!(Number.isFinite(interval) && interval > 0) || !count(opts.maxLanes) || !count(opts.maxStarts) ||
        !(opts.maxLoad === undefined || (Number.isFinite(opts.maxLoad) && opts.maxLoad > 0))) {
        throw new Refusal("--interval and --max-load must be finite positive numbers; --max-lanes and --max-starts whole numbers >= 0");
      }
      do {
        try {
          const run = await loopTick(d, opts);
          console.log(run.skipped ? `LOOP skipped: ${run.skipped}` : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`);
        } catch (e) {
          console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
          if (one(a, "once")) return 1;
        }
        if (one(a, "once")) break;
        opts.force = false;
        await Bun.sleep(msUntilNext(d, interval));
      } while (true);
      return 0;
    }
    case "backlog": {
      if (x === "add") {
        const id = need(a.pos[2], "item id");
        const p = one(a, "priority");
        const item = backlogAdd(d, id, need(one(a, "brief"), "--brief"), {
          title: one(a, "title"), cwd: one(a, "cwd"), decision: one(a, "decision"),
          ...(p !== undefined ? { priority: Number(p) } : {}),
        });
        console.log(`ADDED ${item.id} p${item.priority}${item.decision ? " (needs decision)" : ""}`);
      } else if (x === "list" || x === undefined) {
        for (const i of d.store.items()) {
          console.log(`${i.id.padEnd(24)} ${i.status.padEnd(8)} p${i.priority}  ${i.decision ? `DECIDE: ${i.decision}` : i.title}`);
        }
      } else if (x === "decide") {
        const id = need(a.pos[2], "item id");
        backlogDecide(d, id, await textOf(a));
        console.log(`DECIDED ${id}`);
      } else if (x === "drop") {
        const id = need(a.pos[2], "item id");
        backlogDrop(d, id, one(a, "text"));
        console.log(`DROPPED ${id}`);
      } else if (x === "import") {
        const { added, capped } = await backlogImport(d, need(a.pos[2], "owner/repo"), one(a, "label") ?? "dori", one(a, "cwd"));
        console.log(`IMPORTED ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
        if (capped) console.error(`WARNING: gh returned ${IMPORT_LIMIT} issues, the import limit; some labelled issues may be missing`);
      } else {
        throw new Refusal(`unknown backlog command ${x}\n\n${USAGE}`);
      }
      return 0;
    }
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} base=${r.baseSha} verdict=${r.verdict} report=${r.reportPath}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge": {
      const method = one(a, "method") ?? "merge";
      if (method !== "merge") throw new Refusal("--method must be merge; reviewed-pair integration preserves both parents");
      console.log(await mergeGate(d, need(x, "PR"), { dryRun: one(a, "dry-run") === "true", method: "merge" }));
      return 0;
    }
    case "done":
      await done(d, need(x, "lane key"), one(a, "instance"));
      console.log(`DONE ${x}`);
      return 0;
    case "status":
      status(d);
      return 0;
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
  }
}

if (import.meta.main) {
  try { process.exit(await main(process.argv.slice(2))); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(e instanceof Refusal ? 2 : 1); }
}
