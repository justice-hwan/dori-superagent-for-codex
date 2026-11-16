import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { object } from "../src/runtime/codex/protocol.ts";
import { fixture } from "./codex-fixture.test.ts";

const cases = [
  {
    label: "disabled",
    fields: { runtimeStatus: "disabled", pluginId: "fixture-plugin" },
    runtime: { state: "value", value: "disabled" },
    plugin: "value",
  },
  {
    label: "connected",
    fields: { runtimeStatus: "connected", pluginId: null },
    runtime: { state: "value", value: "connected" },
    plugin: "null",
  },
  { label: "null", fields: { runtimeStatus: null }, runtime: { state: "null" }, plugin: "missing" },
  { label: "missing", fields: {}, runtime: { state: "missing" }, plugin: "missing" },
  {
    label: "malformed",
    fields: { runtimeStatus: { secret: "DO_NOT_RETAIN" }, pluginId: 123 },
    runtime: { state: "malformed" },
    plugin: "malformed",
  },
  {
    label: "unknown string",
    fields: { runtimeStatus: "DO_NOT_RETAIN" },
    runtime: { state: "malformed" },
    plugin: "missing",
  },
] as const;

const rejected = async (f: Awaited<ReturnType<typeof fixture>>, review = false) => {
  let refusal: unknown;
  try {
    if (review) await f.rt.runReview("Must refuse before any turn");
    else await f.rt.create({ ...f.spec, role: "lead", env: {} });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  if (!(refusal instanceof Error)) throw new Error("Expected actual admission refusal");
  expect(refusal.message).toContain("unexpected MCP servers");
  expect(f.calls.filter((method) => method === "turn/start")).toEqual([]);
  expect(f.config.reads).toHaveLength(2);
  expect(f.config.closes).toEqual(["thread/archive"]);
  const id = f.threads.keys().next().value;
  if (!id) throw new Error("Missing actual created thread");
  const path = new CodexStore(f.root).path(id);
  const evidence = Bun.file(`${path}.mcp-admission`);
  const saved = (await evidence.exists()) ? await evidence.json() : undefined;
  expect(saved).toBeDefined();
  expect(Object.getOwnPropertyDescriptor(refusal, "mcpAdmission")?.value).toEqual(saved);
  return { refusal, details: object(saved), record: object(await Bun.file(path).json()) };
};

test.each(cases)("admission retains $label inventory facets while refusing unexpected authority", async (row) => {
  const f = await fixture();
  const user = join(dirname(f.root), "codex-home");
  mkdirSync(user);
  writeFileSync(join(user, "config.toml"), '[mcp_servers.before]\ncommand="/DO_NOT_RETAIN"\n');
  f.config.lateServer = "after";
  f.config.statusPages = [
    [
      {
        name: "only-status",
        ...row.fields,
        tools: { lookup: { description: "DO_NOT_RETAIN" } },
        resources: [{ uri: "DO_NOT_RETAIN" }, { text: "DO_NOT_RETAIN" }],
        resourceTemplates: [{ description: "DO_NOT_RETAIN" }],
      },
    ],
  ];
  const { details, record } = await rejected(f);
  expect(record["closed"]).toBe(true);
  expect(details["preStart"]).toMatchObject({ total: 1, omitted: 0, values: [{ value: "before", truncated: false }] });
  expect(details["postConfig"]).toMatchObject({
    state: "observed",
    total: 2,
    omitted: 0,
    values: [{ value: "before" }, { value: "after" }],
  });
  expect(details["status"]).toMatchObject({
    pages: 1,
    rowsTotal: 1,
    omittedRows: 0,
    rows: [
      {
        observation: "status",
        name: { state: "value", value: { value: "only-status" } },
        runtimeStatus: row.runtime,
        pluginId: { state: row.plugin },
        tools: { state: "value", value: 1 },
        resources: { state: "value", value: 2 },
        resourceTemplates: { state: "value", value: 1 },
      },
    ],
  });
  expect(JSON.stringify(details)).not.toContain("DO_NOT_RETAIN");
  expect(f.config.statusReads).toHaveLength(1);
});

test("paginated diagnostics bound cardinality and text without dropping admission checks", async () => {
  const f = await fixture();
  const rows = Array.from({ length: 40 }, (_, index) => ({
    name: `server-${index}-${"x".repeat(200)}`,
    runtimeStatus: "disabled",
    pluginId: "p".repeat(200),
    tools: "DO_NOT_RETAIN",
    resources: null,
  }));
  const user = join(dirname(f.root), "codex-home");
  mkdirSync(user);
  writeFileSync(
    join(user, "config.toml"),
    Array.from(
      { length: 40 },
      (_, index) => `[mcp_servers.configured-${index}-${"x".repeat(200)}]\ncommand="/DO_NOT_RETAIN"\n`,
    ).join(""),
  );
  f.config.statusPages = rows.map((row) => [row]);
  const { details, refusal } = await rejected(f);
  const status = object(details["status"]);
  expect(status).toMatchObject({ pages: 40, rowsTotal: 40, omittedRows: 24, omittedPages: 24 });
  expect(details["preStart"]).toMatchObject({ total: 40, omitted: 24 });
  expect(details["postConfig"]).toMatchObject({ state: "observed", total: 40, omitted: 24 });
  expect(object(details["preStart"])["values"]).toHaveLength(16);
  expect(object(details["postConfig"])["values"]).toHaveLength(16);
  expect(status["rows"]).toHaveLength(16);
  const capturedRows = status["rows"];
  if (!Array.isArray(capturedRows)) throw new Error("Missing bounded status rows");
  const first = object(capturedRows[0]);
  expect(first).toMatchObject({
    name: { state: "value", value: { length: rows[0]?.name.length, truncated: true, digest: expect.any(String) } },
    pluginId: { state: "value", value: { length: 200, truncated: true, digest: expect.any(String) } },
    tools: { state: "malformed" },
    resources: { state: "null" },
    resourceTemplates: { state: "missing" },
  });
  expect(JSON.stringify(details).length).toBeLessThan(24000);
  expect(refusal.message.length).toBeLessThan(2000);
  expect(f.config.statusReads).toHaveLength(40);
  expect(JSON.stringify(details)).not.toContain("DO_NOT_RETAIN");
});

test("review cleanup failure keeps original refusal and safe diagnostic evidence", async () => {
  const f = await fixture();
  f.config.statusPages = [[{ name: "unconfigured", runtimeStatus: null }]];
  f.config.closeMode = "fail";
  const { refusal, details, record } = await rejected(f, true);
  expect(refusal.cause).toBeInstanceOf(Error);
  expect(record).toMatchObject({ closed: false, admission: "pending", uncertain: expect.any(String) });
  expect(details["status"]).toMatchObject({ rows: [{ runtimeStatus: { state: "null" } }] });
});

test("diagnostic persistence failure never masks refusal or prevents admission cleanup", async () => {
  const f = await fixture();
  f.config.statusPages = [[{ name: "unconfigured", runtimeStatus: "disabled" }]];
  f.config.statusObserver = () => {
    const id = f.threads.keys().next().value;
    if (!id) throw new Error("No actual created thread");
    mkdirSync(`${new CodexStore(f.root).path(id)}.mcp-admission`);
  };
  let refusal: unknown;
  try {
    await f.rt.create({ ...f.spec, role: "lead", env: {} });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  if (!(refusal instanceof Error)) throw new Error("Missing actual refusal");
  expect(refusal.message).toContain("unexpected MCP servers");
  expect(refusal.cause).toMatchObject({ code: "EEXIST" });
  expect(f.config.closes).toEqual(["thread/archive"]);
  expect(f.calls.filter((method) => method === "turn/start")).toEqual([]);
  const id = f.threads.keys().next().value;
  if (!id) throw new Error("Missing owned refusal record");
  expect(await Bun.file(new CodexStore(f.root).path(id)).json()).toMatchObject({ closed: true, admission: "pending" });
});
