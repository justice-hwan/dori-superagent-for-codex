import { expect, test } from "bun:test";
import { Events } from "./events.ts";
import { Jobs } from "./jobs.ts";
import { mcp } from "./mcp.ts";
import { Principal } from "./schema.ts";
import { Store } from "./store.ts";

const principal = Principal.parse("account-a");
test("MCP initialization advertises usable Events discovery on the same authenticated transport", async () => {
  const store = new Store(":memory:", "personal");
  const events = new Events(store, async () => true);
  const jobs = new Jobs(store, ["/usr/bin/false"], () => events.drain(), ["/usr/bin/false"], "/private/config");
  const request = (method: string, params: unknown) =>
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  try {
    const initialization = await mcp(
      request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      }),
      principal,
      Date.now() + 60000,
      store,
      jobs,
      events,
    );
    expect(initialization.status).toBe(200);
    expect(await initialization.json()).toMatchObject({
      result: { capabilities: { events: {}, tools: {} } },
    });
    const discovery = await mcp(request("events/list", {}), principal, Date.now() + 60000, store, jobs, events);
    expect(await discovery.json()).toMatchObject({
      result: {
        events: [
          { name: "dori.job.completed", delivery: ["webhook"] },
          { name: "dori.job.decision_needed", delivery: ["webhook"] },
        ],
      },
    });
  } finally {
    events.close();
    store.close();
  }
});

test("MCP status returns the durable outcome only to its authenticated owner", async () => {
  const store = new Store(":memory:", "personal");
  const events = new Events(store, async () => true);
  const jobs = new Jobs(store, ["/usr/bin/false"], () => events.drain(), ["/usr/bin/false"], "/private/config");
  const job = store.submit(principal, {
    origin_id: "dot",
    request_id: "request",
    prompt: "Inspect status",
  });
  store.update({
    job_id: job.id,
    revision: 1,
    state: "completed",
    summary: "Verified",
    thread_id: "thread-1",
  });
  const request = () =>
    new Request("https://bridge.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "dori_job_status",
          arguments: { job_id: job.id },
        },
      }),
    });
  try {
    const response = await mcp(request(), principal, Date.now() + 60000, store, jobs, events);
    expect(await response.text()).toContain('\\"summary\\":\\"Verified\\"');
    const denied = await mcp(request(), Principal.parse("other"), Date.now() + 60000, store, jobs, events);
    expect(await denied.json()).toMatchObject({
      result: { isError: true, content: [{ text: "job_not_found" }] },
    });
  } finally {
    events.close();
    store.close();
  }
});
