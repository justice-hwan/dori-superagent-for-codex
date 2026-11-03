#!/usr/bin/env bun
import { createInterface } from "node:readline";
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
const threads = new Map<string, { turn?: string; text?: string }>();
let initialized = false, next = 0, nextTurn = 0;
let approvalThread = "";
const event = (method: string, params: unknown) => send({ method, params });
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line), p = m.params ?? {};
  if (!m.method) {
    if (m.id === "approval-1") {
      const id = approvalThread;
      event("serverRequest/resolved", { requestId: m.id, threadId: id });
      event("turn/completed", { threadId: id, turn: { id: threads.get(id)?.turn, status: "completed" } });
    }
    return;
  }
  const ok = (result: unknown) => send({ id: m.id, result });
  const fail = (message: string) => send({ id: m.id, error: { code: -32600, message } });
  if (m.method === "initialize") { initialized = true; ok({ userAgent: "test" }); return; }
  if (m.method === "initialized") return;
  if (!initialized) { fail("not initialized"); return; }
  if (m.method === "account/read") { ok({ account: { type: "chatgpt" } }); return; }
  if (m.method === "thread/start") {
    const id = `thread-${++next}`; threads.set(id, {}); ok({ thread: { id, status: { type: "idle" } } }); return;
  }
  if (m.method === "thread/resume") {
    if (p.threadId.startsWith("empty-")) { fail("no rollout found for thread id"); return; }
    if (p.threadId.startsWith("missing-")) { fail("no rollout found for thread id"); return; }
    threads.set(p.threadId, {}); ok({ thread: { id: p.threadId, status: { type: "idle" } } }); return;
  }
  if (m.method === "thread/read") { ok({ thread: { id: p.threadId, status: { type: "idle" } } }); return; }
  if (m.method === "thread/archive") { threads.delete(p.threadId); ok({}); return; }
  if (m.method === "turn/interrupt") {
    ok({}); event("turn/completed", { threadId: p.threadId, turn: { id: p.turnId, status: "interrupted" } }); return;
  }
  if (m.method === "turn/start") {
    const text = p.input[0].text, turn = `turn-${++nextTurn}`;
    if (text === "DROP") { process.exit(0); }
    if (text === "REFUSE") { fail("turn refused"); return; }
    threads.set(p.threadId, { turn, text });
    ok({ turn: { id: turn, status: "inProgress" } });
    event("turn/started", { threadId: p.threadId, turn: { id: turn, status: "inProgress" } });
    if (text === "APPROVE") {
      approvalThread = p.threadId;
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: p.threadId, turnId: turn, command: "fixture command" } }); return;
    }
    if (text === "HOLD") return;
    setTimeout(() => {
      const output = text === "FAIL" ? "partial result" : text;
      event("item/agentMessage/delta", { threadId: p.threadId, delta: output });
      event("item/completed", { threadId: p.threadId, item: { type: "agentMessage", text: output, phase: "final_answer" } });
      event("turn/completed", { threadId: p.threadId, turn: { id: turn, status: text === "FAIL" ? "failed" : "completed" } });
    }, 20);
    return;
  }
  fail("unsupported method");
});
