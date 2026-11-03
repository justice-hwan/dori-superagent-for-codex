import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done, dutyTick, mergeGate, ready, Refusal, report, review, send, startLane } from "../src/harness.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addThread("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

describe("lanes", () => {
  test("start opens a thread, launches Codex with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief);
    const thread = w.threads.get(lane.threadId)!;
    expect(thread.received[0]).toStartWith("Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.threadId}`]);
    await expect(startLane(d, "fix-login", brief)).rejects.toThrow(Refusal);
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief);
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    await done(d, "fix-login");
    expect(w.threads.has(lane.threadId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("thread messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief);
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ thread: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("nudges an idle lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief);
    const thread = w.threads.get(lane.threadId)!;
    thread.status = "idle";
    const at = async (min: number) => { w.clock = lane.createdAt + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(thread.received.at(-1)).toContain("idle for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief);
    w.threads.get(waiting.threadId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one thread does not stop the loop for the other threads", async () => {
    const { w, d, lead } = setup();
    const broken = w.addThread("w1:p9", "idle");
    w.promptFails.set("w1:p9", "Codex exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue("w1:p1", { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ thread: "w1:p9", action: "flush-failed", detail: expect.stringContaining("Codex exploded") });
    expect(events).toContainEqual({ thread: "w1:p1", action: "flushed" });
    expect(lead.received).toEqual(["to lead"]);
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief);
    const stuck = await startLane(d, "stuck-lane", brief);
    const fine = await startLane(d, "fine-lane", brief);
    w.threads.delete(lost.threadId);
    w.threads.get(stuck.threadId)!.status = "idle";
    w.threads.get(fine.threadId)!.status = "idle";
    w.promptFails.set("w1:p1", "lead exploded");
    w.promptFails.set(stuck.threadId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.threads.get(fine.threadId)!.received.at(-1)).toContain("idle for 10 minutes");
  });

  test("a LOST notice whose lead delivery failed once still reaches the lead on the next tick, exactly once", async () => {
    const { w, d, lead, brief } = setup();
    const gone = await startLane(d, "gone-lane", brief);
    lead.received.length = 0;
    w.threads.delete(gone.threadId);
    w.promptFails.set("w1:p1", "lead exploded");
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(lead.received).toEqual([]);
    w.promptFails.delete("w1:p1");
    const events = await dutyTick(d);
    expect(events).toContainEqual({ thread: "w1:p1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
  });

  test("the flush-failed detail is Codex's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addThread("w1:p9", "idle");
    w.promptFails.set("w1:p9", "Codex exploded\nsecond line");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ thread: "w1:p9", action: "flush-failed", detail: "sessions deliver: Codex exploded" }]);
  });

  test("the duty loop prints a flush-failed line with the reason", async () => {
    const { w, d } = setup();
    w.addThread("w1:p9", "idle");
    w.promptFails.set("w1:p9", "Codex exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("DUTY w1:p9 flush-failed: ");
    expect(lines[0]).toContain("Codex exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief);
    w.threads.get(lane.threadId)!.status = "idle";
    lead.status = "working";
    expect(await send(d, "lead", "held note", "cli")).toBe("QUEUED");
    lead.status = "idle";
    lead.received.length = 0;
    w.clock = lane.createdAt + 40 * 60_000;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "stop", "--text", "maintenance"], d)).toBe(0);
      expect(await main(["duty", "--once"], d)).toBe(0);
      expect(await main(["duty", "status"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(["DUTY STOPPED", "DUTY stopped: maintenance", "stopped: maintenance"]);
    expect(lead.received).toEqual([]);
    expect(d.store.lane("quiet")!.nudges).toBe(0);
    expect(d.store.stop()).toBeUndefined();

    await main(["duty", "resume"], d);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ thread: "w1:p1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("a working lane counts as activity; a vanished thread is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief);
    w.threads.get(lane.threadId)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    w.threads.delete(lane.threadId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head, baseRefOid: "b".repeat(40), baseRefName: "main", state: "OPEN", isDraft: false }) };
      if (argv[0] === "api") return { code: 0, stdout: JSON.stringify([argv[1]!.includes("check-runs") ? { check_runs: (checks as {name:string;bucket:string}[]).map(c => ({ name: c.name, status: "completed", conclusion: c.bucket === "pass" ? "success" : c.bucket === "skipping" ? "skipped" : "failure" })) } : { statuses: [] }]) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7", { dryRun: true })).toBe(`MERGE_OK o/r#7 head=${head} (dry run)`);
    expect(w.calls.filter(c => c.cmd === "gh" && c.argv[0] === "api").every(c => c.argv[1]!.includes(head))).toBe(true);
  });

  test("a reviewer without a VERDICT line writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "looks fine I guess" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });
});
