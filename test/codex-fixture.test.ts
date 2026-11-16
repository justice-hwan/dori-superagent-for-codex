import { onTestFinished } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import type { CreateSpec } from "../src/runtime/types.ts";
import type { Deps } from "../src/harness.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import { FixtureConfigRead } from "./fixtures/codex-config-read.ts";
import { completeTurn, startTurn, threadView, turnPage } from "./fixtures/codex-history.ts";
import type { FixtureCompletion, FixtureThread } from "./fixtures/codex-history.ts";

/** Wire fixture models the daemon's independent history and per-client subscriptions. */
export const fixture = async () => {
  const directory = await mkdtemp(join(homedir(), ".dori-codex-test-"));
  const root = join(directory, "authority");
  const workspace = join(directory, "workspace");
  await Promise.all([mkdir(root), mkdir(workspace)]);
  const threads = new Map<string, FixtureThread>();
  const sockets = new Set<ServerWebSocket<{ initialized: boolean }>>();
  const calls: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const observers: ((request: Record<string, unknown>) => void)[] = [];
  const started = Promise.withResolvers<string>();
  const resumes: ((id: string) => void)[] = [];
  const admissions: ((id: string) => void)[] = [];
  const cleanup: (() => void | Promise<void>)[] = [];
  let startParams: Record<string, unknown> = {};
  let admission: "accept" | "reject" | "disconnect" | "accept-disconnect" | "malformed" = "accept";
  const config = new FixtureConfigRead(directory);
  let nameFailure = false;
  let attachFailure = false;
  let archiveFailure = false;
  const barrier = (token: string = crypto.randomUUID()) => {
    for (const ws of sockets)
      if (ws.data.initialized) ws.send(JSON.stringify({ method: "fixture/barrier", params: { token } }));
    return token;
  };
  const server = Bun.serve<{ initialized: boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      if (server.upgrade(request, { data: { initialized: false } })) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<{ initialized: boolean }>) {
        sockets.add(ws);
      },
      close(ws: ServerWebSocket<{ initialized: boolean }>) {
        sockets.delete(ws);
      },
      message(ws: ServerWebSocket<{ initialized: boolean }>, message: string | Buffer) {
        const request = object(JSON.parse(String(message)));
        const params = object(request["params"]);
        const method = String(request["method"]);
        calls.push(method);
        requests.push(request);
        for (const observe of observers) observe(request);
        const reply = (result: unknown) => {
          ws.send(JSON.stringify({ id: request["id"], result }));
        };
        const reject = (code: number, message: string) => {
          ws.send(JSON.stringify({ id: request["id"], error: { code, message } }));
        };
        if (method === "initialize") {
          if (object(params["capabilities"])["experimentalApi"] !== true || !object(params["clientInfo"])["name"])
            return reject(-32602, "initialize requires capabilities and client identity");
          return reply({ userAgent: "fixture" });
        }
        if (method === "initialized") {
          ws.data.initialized = true;
          return;
        }
        if (!ws.data.initialized) return reject(-32000, "Not initialized");
        if (method === "fixture/barrier") return reply({ token: barrier(String(params["token"] ?? request["id"])) });
        const handled = config.handle(method, params, startParams);
        if (handled === "hang") return;
        if (handled) return "error" in handled ? reject(-32603, handled.error) : reply(handled.result);
        if (method === "thread/start") {
          startParams = params;
          const id = crypto.randomUUID();
          const thread: FixtureThread = {
            id,
            cwd: typeof params["cwd"] === "string" ? params["cwd"] : workspace,
            archived: false,
            status: { type: "idle" },
            items: [],
            turns: [],
            subscribed: new Set([ws]),
          };
          threads.set(id, thread);
          return reply({ thread: threadView(thread, params) });
        }
        const thread = threads.get(String(params["threadId"]));
        if (!thread) return reject(-32001, "Thread not found");
        switch (method) {
          case "thread/name/set":
            if (nameFailure) return reject(-32602, "Naming rejected");
            thread.name = String(params["name"]);
            return reply({});
          case "thread/read":
            return reply({ thread: threadView(thread, params) });
          case "thread/resume":
            if (attachFailure || thread.archived) return reject(-32602, "Attach rejected");
            thread.subscribed.add(ws);
            if (thread.status.type === "notLoaded") thread.status = { type: "idle" };
            resumes.shift()?.(String(params["threadId"]));
            return reply({ thread: threadView(thread, params) });
          case "thread/archive":
            if (archiveFailure) return reject(-32602, "Archive rejected");
            thread.archived = true;
            thread.subscribed.clear();
            return reply({});
          case "thread/unsubscribe":
            thread.subscribed.delete(ws);
            return reply({});
          case "thread/items/list": {
            const offset = Number(params["cursor"] || 0);
            const data = thread.items.slice(offset, offset + 2).map((item) => ({ item, turnId: "turn-1" }));
            return reply({
              data,
              nextCursor: offset + 2 < thread.items.length ? String(offset + 2) : null,
            });
          }
          case "thread/turns/list":
            return reply(turnPage(thread, params));
          case "turn/start": {
            if (admission === "reject") return reject(-32602, "Rejected turn input");
            if (admission === "disconnect") {
              ws.close();
              return;
            }
            if (thread.status.type !== "idle") return reject(-32000, "Would steer desktop turn");
            for (const observe of admissions) observe(String(params["threadId"]));
            const turn = startTurn(thread, params);
            if (admission === "accept-disconnect") {
              ws.close();
              return;
            }
            if (admission === "malformed") {
              ws.send("not-json");
              return;
            }
            started.resolve(String(params["threadId"]));
            return reply({ turn });
          }
          case "turn/interrupt":
            completeTurn(thread, undefined, { status: "interrupted" });
            return reply({});
          default:
            return reject(-32601, "Unsupported method");
        }
      },
    },
  });
  const env = {
    ...process.env,
    DORI_CODEX_SOCKET: `ws://127.0.0.1:${server.port}`,
  };
  const spec: CreateSpec = {
    name: "lane",
    role: "lane",
    container: "tab",
    cwd: workspace,
    env: { DORI_LANE: "lane one", TEST_VALUE: "scoped" },
    group: "test",
  };
  const rt = new CodexRuntime(root, env);
  onTestFinished(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    for (const ws of sockets) ws.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    root,
    rt,
    env,
    spec,
    threads,
    calls,
    requests,
    barrier,
    onRequest: (observe: (request: Record<string, unknown>) => void) => observers.push(observe),
    cleanup,
    started: started.promise,
    onAdmission: (observe: (id: string) => void) => admissions.push(observe),
    nextResume: () =>
      new Promise<string>((resolve) => {
        resumes.push(resolve);
      }),
    dropClients: () => {
      for (const ws of sockets) ws.close();
    },
    params: () => startParams,
    config,
    admission: (next: typeof admission) => {
      admission = next;
    },
    failNaming: () => {
      nameFailure = true;
    },
    failAttach: (fail = true) => {
      attachFailure = fail;
    },
    failArchive: (fail = true) => {
      archiveFailure = fail;
    },
    finish(id: string, answer: string, completion?: FixtureCompletion) {
      const thread = threads.get(id);
      if (!thread) throw new Error("Unknown fixture thread");
      return completeTurn(thread, answer, completion);
    },
  };
};

export const harnessFixture = async () => {
  const f = await fixture();
  const world = new World();
  const d: Deps = {
    store: new Store(f.root),
    runtimes: new Runtimes("codex", () => f.rt),
    choice: () => ({ kind: "codex", source: "env" }),
    exec: world.exec,
    now: () => world.clock,
    agentCmd: "unused",
    doriCmd: "unused",
    host: () => world.host,
    usage: world.recorder,
  };
  return { f, d };
};
