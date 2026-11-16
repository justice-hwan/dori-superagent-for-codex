import type { ServerWebSocket } from "bun";

export type FixtureTurn = {
  readonly id: string;
  readonly items: Record<string, unknown>[];
  status: "inProgress" | "completed" | "failed" | "interrupted";
  error: Record<string, unknown> | null;
};

/** Mutable daemon state; legacy flat items remain independent from canonical turns. */
export type FixtureThread = {
  readonly id: string;
  readonly cwd: string;
  name?: string;
  archived: boolean;
  status: { type: string; activeFlags?: readonly string[] };
  readonly items: Record<string, unknown>[];
  readonly turns: FixtureTurn[];
  readonly subscribed: Set<ServerWebSocket<{ initialized: boolean }>>;
};

export type FixtureCompletion = {
  readonly status?: "completed" | "failed" | "interrupted";
  readonly error?: Record<string, unknown>;
};

export const startTurn = (thread: FixtureThread, params: Record<string, unknown>) => {
  const client = typeof params["clientUserMessageId"] === "string" ? { clientId: params["clientUserMessageId"] } : {};
  thread.status = { type: "active", activeFlags: [] };
  thread.items.push({ type: "userMessage", content: params["input"], ...client });
  const turn: FixtureTurn = {
    id: crypto.randomUUID(),
    items: [{ id: crypto.randomUUID(), type: "userMessage", content: structuredClone(params["input"]), ...client }],
    status: "inProgress",
    error: null,
  };
  thread.turns.push(turn);
  return turn;
};

export const completeTurn = (thread: FixtureThread, answer: string | undefined, completion: FixtureCompletion = {}) => {
  const turn: FixtureTurn = thread.turns.findLast((candidate) => candidate.status === "inProgress") ?? {
    id: crypto.randomUUID(),
    items: [],
    status: "inProgress",
    error: null,
  };
  if (!thread.turns.includes(turn)) thread.turns.push(turn);
  if (answer !== undefined) {
    thread.items.push({ type: "agentMessage", text: answer });
    turn.items.push({ id: crypto.randomUUID(), type: "agentMessage", phase: "final_answer", text: answer });
  }
  turn.status = completion.status ?? "completed";
  turn.error = completion.error ?? null;
  thread.status = { type: "idle" };
  for (const ws of thread.subscribed)
    ws.send(JSON.stringify({ method: "turn/completed", params: { threadId: thread.id, turn } }));
  return turn;
};

export const threadView = (thread: FixtureThread, params: Record<string, unknown>) => ({
  id: thread.id,
  cwd: thread.cwd,
  status: thread.status,
  ...(params["includeTurns"] === true || params["excludeTurns"] === false ? { turns: thread.turns } : {}),
});

/** Small default pages force consumers to exercise the same bounded reads as the daemon. */
export const turnPage = (thread: FixtureThread, params: Record<string, unknown>) => {
  const ordered = params["sortDirection"] === "asc" ? thread.turns : [...thread.turns].reverse();
  const offset = Number(params["cursor"] || 0);
  const requested = typeof params["limit"] === "number" ? params["limit"] : 2;
  const limit = Math.max(1, Math.min(100, Math.trunc(requested)));
  const data = ordered.slice(offset, offset + limit).map((turn) => ({
    ...turn,
    items: params["itemsView"] === "none" ? [] : turn.items,
  }));
  return { data, nextCursor: offset + limit < ordered.length ? String(offset + limit) : null };
};
