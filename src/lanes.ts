import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { prompt, type Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { admitHeld, admitLane, identifiedInbox } from "./lane-admission.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { NativeStartUncertain, openSession } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  const rt = d.runtimes.default;
  const cwd = resolve(
    opts.cwd ?? (rt.kind === "codex" ? process.env["DORI_CODEX_WORKSPACE"] : undefined) ?? process.cwd(),
  );
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
  // workspace stays there); otherwise herdr gets a new "dori" workspace and hc this home's group label.
  const self = d.runtimes.selfAny(process.env);
  const group =
    opts.group ??
    (self?.runtime === rt.kind ? self.group : undefined) ??
    (rt.kind === "herdr" ? await rt.createGroup("dori", cwd) : groupId(d.store.root));
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  let uncertain: NativeStartUncertain | undefined;
  const ref = await openSession(
    rt,
    { name: key, role: "lane", container: "tab", cwd, env: { DORI_LANE: key, DORI_HOME: d.store.root }, group },
    rt.kind === "codex" ? { prompt: kickoff } : `${d.agentCmd} ${shq(kickoff)}`,
  ).catch((error: unknown) => {
    if (!(error instanceof NativeStartUncertain)) throw error;
    uncertain = error;
    return error.ref;
  });

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.container ?? "",
    brief: briefPath,
    cwd,
    status: uncertain ? "waiting" : "working",
    createdAt: now,
    lastActivityAt: now,
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  if (uncertain) {
    d.store.enqueue(ref, {
      at: now,
      from: "startup",
      text: kickoff,
      attempt: { at: now, state: "ambiguous", detail: uncertain.message },
    });
    await settled(tellLead(d, `[START ${key} WAITING] ${uncertain.message}`, key));
    throw uncertain;
  }
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(
  d: Deps,
  key: string,
  text: string,
  status?: "working" | "waiting",
): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: "" });
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const now = d.now();
  const initial = openLane(d, key);
  const release = d.store.lockInbox(initial.sessionRef, now);
  if (!release) throw new Refusal(`lane ${key} inbox is busy; try again`);
  let lane: Lane;
  try {
    const confirmed = await d.runtimes.for(initial.sessionRef).confirmedDelivery?.(initial.sessionRef);
    if (confirmed) admitLane(d, initial.sessionRef, confirmed.id);
    for (const message of identifiedInbox(d, initial.sessionRef)) admitHeld(d, initial.sessionRef, message);
    lane = openLane(d, key);
    lane.status = "ready";
    lane.final = { text, evidence: [...evidence], at: now };
    lane.lastActivityAt = now;
    lane.log.push({ at: now, kind: "ready", text });
    d.store.saveLane(lane);
  } finally {
    release();
  }
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

export async function done(d: Deps, key: string): Promise<void> {
  const initial = d.store.lane(key);
  if (!initial) throw new Refusal(`no lane ${key}`);
  const release = d.store.lockInbox(initial.sessionRef, d.now());
  if (!release) throw new Refusal(`lane ${key} inbox is busy; try again`);
  try {
    const rt = d.runtimes.for(initial.sessionRef);
    const confirmed = await rt.confirmedDelivery?.(initial.sessionRef);
    if (confirmed) admitLane(d, initial.sessionRef, confirmed.id);
    const lane = openLane(d, key);
    if (lane.status !== "ready")
      throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
    d.store.mergeForwarded(lane.sessionRef);
    if (d.store.queued(lane.sessionRef).length)
      throw new Refusal(`lane ${key} inbox has pending work; deliver it before closing`);
    const { status: st } = await rt.probe(lane.sessionRef);
    if (st === "working" || st === "blocked" || st === "error")
      throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
    if (st !== "gone") await rt.close(lane.sessionRef);
    lane.status = "done";
    lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
    d.store.saveLane(lane);
  } finally {
    release();
  }
}
