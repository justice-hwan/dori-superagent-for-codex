import { createHash } from "node:crypto";
import { KEY_RE, type Lane } from "./store.ts";
import { flushInbox, tellLead, Refusal, type Deps } from "./harness.ts";

export function checkInstance(d: Deps, lane: Lane, instance?: string): void {
  if (d.store.roles().conversation && instance !== lane.threadId) throw new Refusal("task instance changed or is missing; inspect task show and supply --instance THREAD");
}
export const revisionOf = (lane: Lane): number => lane.revision ?? 1;
export function findTasks(d: Deps, query = ""): Lane[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return d.store.lanes().filter(l => l.status !== "done" && l.status !== "lost").filter(l => {
    const text = [l.key, l.threadId, l.title, l.direction].join(" ").toLocaleLowerCase();
    return words.every(w => text.includes(w));
  });
}
export function taskFor(d: Deps, selector: string, includeClosed = false): Lane {
  const exact = (KEY_RE.test(selector) ? d.store.lane(selector) : undefined) ?? d.store.lanes().find(l => l.threadId === selector);
  if (exact && (includeClosed || (exact.status !== "done" && exact.status !== "lost"))) return exact;
  const candidates = findTasks(d, selector);
  if (candidates.length !== 1) throw new Refusal(`task selection ${candidates.length ? "is ambiguous" : "did not match"}; use a lane key${candidates.length ? `: ${candidates.map(l => l.key).join(", ")}` : ""}`);
  return candidates[0]!;
}
export async function pivot(d: Deps, selector: string, text: string, expectedRevision?: number, sourceEvent?: string): Promise<Lane> {
  if (!text.trim()) throw new Refusal("pivot requires the new direction");
  const selected = taskFor(d, selector);
  const unlock = d.store.lockLaneMutation(selected.key);
  if (!unlock) throw new Refusal("task is being updated; refresh and retry");
  let lane: Lane;
  try {
    lane = d.store.lane(selected.key)!;
    if (lane.threadId !== selected.threadId || lane.status === "done" || lane.status === "lost") throw new Refusal("task changed before pivot");
    const previous = sourceEvent ? lane.instructions?.find(i => i.sourceEvent === sourceEvent) : undefined;
    if (previous) {
      if (previous.text !== text.trim()) throw new Refusal("source event conflicts with previous pivot");
      if (previous.message?.id) d.store.enqueueOnce(lane.threadId, previous.message as typeof previous.message & { id: string });
      return lane;
    }
    const current = revisionOf(lane);
    if (expectedRevision !== undefined && current !== expectedRevision) throw new Refusal(`task revision changed; current revision is ${current}`);
    const revision = current + 1;
    if (!Number.isSafeInteger(revision)) throw new Refusal("task revision limit reached");
    const id = `pivot-${createHash("sha256").update(`${lane.key}:${lane.createdAt}:${revision}`).digest("hex")}`;
    // Persist the revision before admission. Any late READY for the old revision is now stale.
    lane.revision = revision; lane.direction = text.trim(); lane.status = "working"; delete lane.final;
    const at = d.now();
    const message = { id, at, from: "pivot", mode: "steer" as const, revision,
      text: `[TASK ${lane.key} REVISION ${revision}] ${text.trim()}\nThis supersedes earlier directions. Acknowledge the current revision with ${d.doriCmd} ack ${lane.key} --instance ${lane.threadId} --revision ${revision}; acknowledgement means you understood it, not that implementation is complete. READY must include --instance ${lane.threadId} --revision ${revision}. Do not interrupt or seek broader permissions automatically.` };
    lane.instructions ??= []; lane.instructions.push({ revision, text: text.trim(), at, status: "queued", message, sourceEvent });
    lane.lastActivityAt = at; lane.nudges = 0;
    lane.log.push({ at, kind: "report", text: `pivot revision ${revision}: ${text.trim()}` });
    d.store.saveLane(lane);
    d.store.enqueueOnce(lane.threadId, message);
  } finally { unlock(); }
  await flushInbox(d, lane!.threadId);
  await tellLead(d, `[PIVOT ${lane!.key} r${revisionOf(lane!)}] ${text.trim()} (worker acknowledgement pending)`, "conversation");
  return d.store.lane(lane!.key)!;
}
/** Recover the write-ahead revision→inbox gap without creating a second revision. */
export function recoverTaskInputs(d: Deps): void {
  for (const observed of d.store.lanes()) {
    if (observed.status === "done" || observed.status === "lost") continue;
    d.store.editLane(observed.key, lane => {
      if (lane.threadId !== observed.threadId || lane.status === "done" || lane.status === "lost") return false;
      for (const instruction of lane.instructions ?? []) if (instruction.message?.id) d.store.enqueueOnce(lane.threadId, instruction.message as typeof instruction.message & { id: string });
      return false;
    });
  }
}
export function acknowledge(d: Deps, key: string, revision: number, instance?: string): Lane {
  return d.store.editLane(key, l => {
    checkInstance(d, l, instance);
    if (!Number.isSafeInteger(revision) || revision !== revisionOf(l) || l.status === "done" || l.status === "lost") throw new Refusal("acknowledgement must name the current open task revision");
    const instruction = l.instructions?.find(i => i.revision === revision);
    if (!instruction) throw new Refusal("there is no instruction at that revision");
    if (instruction.status === "acknowledged") return false;
    instruction.status = "acknowledged"; instruction.acknowledgedAt = d.now();
    l.lastActivityAt = d.now(); l.log.push({ at: d.now(), kind: "report", text: `worker acknowledged revision ${revision}` });
  });
}
export function checkRevision(lane: Lane, revision?: number): number {
  const current = revisionOf(lane);
  if ((revision ?? 1) !== current) throw new Refusal(`stale or missing revision; current revision is ${current}`);
  if (current > 1 && lane.instructions?.find(i => i.revision === current)?.status !== "acknowledged") throw new Refusal(`worker must acknowledge revision ${current} before READY`);
  return current;
}
export function taskDocument(lane: Lane): string {
  const decision = lane.status === "done" ? "없음" : "완료 검증 및 필요한 결정을 업무 lead가 확인해야 합니다.";
  return `# 요약\n\n${lane.title ?? lane.key} · r${revisionOf(lane)} · ${lane.status}\n\n${lane.final?.text ?? lane.direction ?? "진행 중입니다."}\n\n# 정할 것\n\n${decision}\n\n# 상세\n\n- 담당: [🐾dori/${lane.key}](codex://threads/${encodeURIComponent(lane.threadId)})\n- 최신 방향: ${lane.direction ?? "최초 작업 지시"}\n- 수정 지시: ${lane.instructions?.map(i => `r${i.revision} ${i.status}`).join(", ") ?? "없음"}\n${lane.final?.evidence.map(e => `- 근거: ${e}`).join("\n") ?? ""}\n`;
}
