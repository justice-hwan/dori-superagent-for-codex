import { expect, test } from "bun:test";
import { fixture } from "./codex-fixture.test.ts";
import { object } from "../src/runtime/codex/protocol.ts";

const registrations = {
  pluginDefault: false,
  plugins: [{ name: "fixture-plugin-server", id: "fixture@market", enabled: true }],
  hostApps: true,
} as const;

test("defaults alone retain explicitly enabled plugins and host Apps registrations", async () => {
  const f = await fixture();
  f.config.registrations = registrations;
  const result = f.config.status(
    {},
    {
      cwd: f.spec.cwd,
      config: { plugins: { _default: { enabled: false } }, apps: { _default: { enabled: false } } },
    },
  );
  expect(result).toEqual({
    result: {
      data: [
        { name: "fixture-plugin-server", runtimeStatus: "connected" },
        { name: "codex_apps", runtimeStatus: "connected" },
      ],
      nextCursor: null,
    },
  });
});

test("managed admission excludes explicitly enabled plugins and host Apps before any turn", async () => {
  const f = await fixture();
  f.config.registrations = registrations;
  const ref = await f.rt.create({ ...f.spec, role: "lead", env: {} });
  const id = f.threads.keys().next().value;
  if (!id) throw new Error("Fixture created no thread");
  expect(ref.id).toBe(id);
  expect(f.calls.filter((method) => method === "turn/start")).toEqual([]);
  expect(f.config.closes).toEqual([]);
  expect(f.config.reads).toHaveLength(2);
});

test("review admission excludes plugin and Apps registrations before submitting its own turn", async () => {
  const f = await fixture();
  f.config.registrations = registrations;
  const review = f.rt.runReview("Fixture-only review");
  const next = await Promise.race([
    f.started.then((id) => ({ id })),
    review.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    ),
  ]);
  expect("id" in next).toBe(true);
  if (!("id" in next)) throw new Error("Review did not reach admitted fixture turn");
  f.finish(next.id, "VERDICT: PASS");
  expect((await review).code).toBe(0);
});

test("outer feature gates suppress per-plugin overrides even when thread defaults enable them", async () => {
  const f = await fixture();
  f.config.registrations = registrations;
  const ref = await f.rt.create({ ...f.spec, env: {} });
  const started = f.params();
  const config = object(started["config"]);
  const result = f.config.status(
    {},
    {
      ...started,
      config: {
        ...config,
        plugins: { _default: { enabled: true }, "fixture@market": { enabled: true } },
        apps: { _default: { enabled: true }, fixture: { enabled: true } },
      },
    },
  );
  expect(result).toEqual({ result: { data: [], nextCursor: null } });
  expect(f.threads.has(ref.id)).toBe(true);
});
