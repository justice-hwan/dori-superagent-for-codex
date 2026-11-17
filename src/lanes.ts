import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { nativeMode, prompt, type Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { launchAgent } from "./runtime/launch-agent.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";
import type { SessionRef } from "./runtime/types.ts";
import { nativeGuard } from "./native-guard.ts";

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const lease = nativeMode(d) ? await nativeGuard(d.store.root, `lane:${key}`) : undefined;
  try {
    const existing = d.store.lane(key);
    if (existing && existing.status !== "done" && existing.status !== "lost")
      throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
    const cwd = resolve(opts.cwd ?? process.cwd());
    const briefPath = d.store.briefPath(key);
    const brief = readFileSync(briefFile, "utf8").trimEnd();
    const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
    const rt = d.runtimes.default;
    if (rt.kind === "codex") for (const ref of Object.values(d.store.roles())) rt.assertCaller(ref);
    if (rt.kind !== "codex") await Bun.write(briefPath, `${brief}\n\n${footer}`);

    // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
    // workspace stays there); otherwise herdr gets a new "dori" workspace and hc this home's group label.
    const self = d.runtimes.selfAny(process.env);
    const group =
      opts.group ??
      (self?.runtime === rt.kind ? self.group : undefined) ??
      (rt.kind === "herdr" ? await rt.createGroup("dori", cwd) : groupId(d.store.root));
    const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
    const publish = (ref: SessionRef) => {
      const current = d.store.lane(key);
      if (rt.kind === "codex" && current?.sessionRef.runtime === ref.runtime && current.sessionRef.id === ref.id)
        return;
      const now = d.now();
      d.store.saveLane({
        key,
        sessionRef: ref,
        paneId: ref.id,
        tabId: ref.container ?? "",
        brief: briefPath,
        cwd,
        status: "working",
        createdAt: now,
        lastActivityAt: now,
        nudges: 0,
        log: [{ at: now, kind: "start", text: briefFile }],
      });
    };
    const ref = await launchAgent(
      d,
      { name: key, role: "lane", container: "tab", cwd, env: { DORI_LANE: key, DORI_HOME: d.store.root }, group },
      `lane:${key}`,
      async (command, created) => {
        const nativeBrief = `${brief}\n\n${prompt("lane-footer.md", { key, dori: command })}`;
        await Bun.write(briefPath, nativeBrief);
        publish(created);
        return nativeBrief;
      },
      `${d.agentCmd} ${shq(kickoff)}`,
    );
    if (rt.kind !== "codex") publish(ref);
    const lane = d.store.lane(key);
    if (!lane || lane.sessionRef.runtime !== ref.runtime || lane.sessionRef.id !== ref.id)
      throw new Refusal("published lane identity changed during startup");
    await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
    const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
    d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
    return lane;
  } finally {
    if (lease) await lease[Symbol.asyncDispose]();
  }
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
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
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
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await rt.close(lane.sessionRef);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}
