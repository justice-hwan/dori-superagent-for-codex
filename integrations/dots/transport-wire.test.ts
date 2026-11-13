import { afterAll, expect, mock, test } from "bun:test";
import * as dns from "node:dns/promises";
import * as https from "node:https";
import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { z } from "zod";
import { Events } from "./events.ts";
import { Principal } from "./schema.ts";
import { Store } from "./store.ts";
import { postWebhook } from "./transport.ts";

const originalDns = { ...dns };
const originalHttps = { ...https };
let addresses = [{ address: "8.8.8.8", family: 4 }];
const calls: {
  readonly options: https.RequestOptions;
  readonly body: string;
}[] = [];
let status = 200;
mock.module("node:dns/promises", () => ({
  ...originalDns,
  lookup: async () => addresses,
}));
mock.module("node:https", () => ({
  ...originalHttps,
  request: (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
    class Call extends EventEmitter {
      end(body: string) {
        calls.push({ options, body });
        const response = new IncomingMessage(new Socket());
        response.statusCode = status;
        queueMicrotask(() => {
          callback(response);
          const parsed: unknown = JSON.parse(body);
          const challenge =
            parsed && typeof parsed === "object" && "challenge" in parsed ? parsed.challenge : undefined;
          response.emit("data", Buffer.from(JSON.stringify(challenge ? { challenge } : {})));
          response.emit("end");
          response.destroy();
        });
        return this;
      }
      destroy(error: Error) {
        this.emit("error", error);
        return this;
      }
    }
    return new Call();
  },
}));
afterAll(() => {
  mock.module("node:dns/promises", () => originalDns);
  mock.module("node:https", () => originalHttps);
});

const secretBytes = new Uint8Array(32).fill(7);
const secret = `whsec_${Buffer.from(secretBytes).toString("base64")}`;
const SignedHeaders = z.object({
  "webhook-timestamp": z.string(),
  "webhook-signature": z.string(),
});

test("pins validated DNS to the connection while preserving Host, TLS identity, exact body, and independent HMAC verification", async () => {
  calls.length = 0;
  addresses = [{ address: "8.8.8.8", family: 4 }];
  status = 302;
  const body = JSON.stringify({
    eventId: "event-1",
    data: { summary: "Done" },
  });
  const response = await postWebhook("https://callback.example/events?task=1", secret, "sub-1", "event-1", body);
  expect(response.status).toBe(302);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call) throw new TypeError("Missing delivery");
  expect(call.options).toMatchObject({
    hostname: "8.8.8.8",
    servername: "callback.example",
    path: "/events?task=1",
    rejectUnauthorized: true,
    headers: {
      Host: "callback.example",
      "webhook-id": "event-1",
      "X-MCP-Subscription-Id": "sub-1",
    },
  });
  expect(call.body).toBe(body);
  const headers = SignedHeaders.parse(call.options.headers);
  const timestamp = headers["webhook-timestamp"];
  const signature = headers["webhook-signature"].split(",")[1];
  if (!signature || !timestamp) throw new TypeError("Missing signed headers");
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  expect(
    await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "base64"),
      new TextEncoder().encode(`event-1.${timestamp}.${body}`),
    ),
  ).toBe(true);
});

test("rejects a DNS answer set containing a private address before making a request", async () => {
  calls.length = 0;
  addresses = [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ];
  await expect(postWebhook("https://callback.example/", secret, "sub", "event", "{}")).rejects.toThrow(
    "non_public_address",
  );
  expect(calls).toHaveLength(0);
});

test("verified subscription refresh is idempotent, rotates keys, delivers one correlated event and stops on unsubscribe", async () => {
  calls.length = 0;
  addresses = [{ address: "8.8.8.8", family: 4 }];
  status = 200;
  const store = new Store(":memory:", "personal");
  const events = new Events(store, async () => true);
  const principal = Principal.parse("owner");
  const job = store.submit(principal, {
    origin_id: "dot-task",
    request_id: "request",
    prompt: "Inspect",
  });
  const request = {
    name: "dori.job.decision_needed" as const,
    arguments: { job_id: job.id },
    delivery: {
      mode: "webhook" as const,
      url: "https://callback.example/events",
      secret,
    },
    ttlMs: 60000,
  };
  try {
    const first = await events.subscribe(principal, request, Date.now() + 120000);
    const refresh = await events.subscribe(principal, request, Date.now() + 120000);
    expect(refresh.id).toBe(first.id);
    expect(calls).toHaveLength(1);
    const replacement = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
    await events.subscribe(
      principal,
      { ...request, delivery: { ...request.delivery, secret: replacement } },
      Date.now() + 120000,
    );
    store.update({
      job_id: job.id,
      revision: 1,
      state: "decision_needed",
      summary: "Choose a branch",
      thread_id: "thread-1",
    });
    await events.drain();
    expect(calls).toHaveLength(3);
    const delivery = calls[2];
    if (!delivery) throw new TypeError("Missing event delivery");
    expect(JSON.parse(delivery.body)).toMatchObject({
      name: request.name,
      data: {
        job_id: job.id,
        origin_id: "dot-task",
        request_id: "request",
        summary: "Choose a branch",
      },
    });
    const headers = SignedHeaders.parse(delivery.options.headers);
    const signatures = headers["webhook-signature"].split(" ");
    expect(signatures).toHaveLength(2);
    for (const [index, bytes] of [new Uint8Array(32).fill(8), secretBytes].entries()) {
      const signature = signatures[index]?.split(",")[1];
      if (!signature) throw new TypeError("Missing rotated signature");
      const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
      expect(
        await crypto.subtle.verify(
          "HMAC",
          key,
          Buffer.from(signature, "base64"),
          new TextEncoder().encode(
            `${JSON.parse(delivery.body).eventId}.${headers["webhook-timestamp"]}.${delivery.body}`,
          ),
        ),
      ).toBe(true);
    }
    expect(store.pending(Date.now())).toHaveLength(0);
    events.unsubscribe(principal, {
      ...request,
      delivery: { mode: "webhook", url: request.delivery.url },
    });
    events.unsubscribe(principal, {
      ...request,
      delivery: { mode: "webhook", url: request.delivery.url },
    });
    store.update({
      job_id: job.id,
      revision: 2,
      state: "decision_needed",
      summary: "Choose another branch",
      thread_id: "thread-1",
    });
    await events.drain();
    expect(calls).toHaveLength(3);
  } finally {
    events.close();
    store.close();
  }
});
