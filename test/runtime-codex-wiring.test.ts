import { expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { up } from "../src/cli-up.ts";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { flushInbox, send } from "../src/inbox.ts";
import { startLane } from "../src/lanes.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { parseRef, type SessionRef } from "../src/runtime/types.ts";
import { Store } from "../src/store.ts";
import { fixture } from "./codex-fixture.test.ts";
import { World } from "./fake.ts";

const threadId = "01a1d541-a2b3-7e53-bdd1-bd387e200ac4";
test.each([threadId, `worker-${threadId}`])("Codex ref %s survives parsing and scoped self-discovery", (id) => {
  const ref: SessionRef = { runtime: "codex", id };
  const rts = new Runtimes("codex", () => {
    throw new TypeError("Self-discovery must not build a runtime");
  });
  expect(parseRef(`codex:${id}`)).toEqual(ref);
  expect(rts.selfAny({ DORI_RUNTIME: "codex", CODEX_THREAD_ID: id, HC_TERMINAL_ID: "t7" })).toEqual(ref);
  expect(parseRef("codex:../../credentials")).toBeUndefined();
});

const setup = async () => {
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
  const lead = await f.rt.create({ ...f.spec, name: "lead", role: "lead" });
  d.store.setRole("lead", lead);
  return { f, d, lead };
};

test("CLI handoff holds inbox delivery until idle takeback and duty reconciliation", async () => {
  const { f, d, lead } = await setup();
  await main(["handoff", "lead"], d);
  expect(await send(d, "lead", "after desktop", "operator")).toBe("QUEUED");

  await main(["takeback", "lead"], d);
  await dutyTick(d);

  expect(d.store.queued(lead)).toEqual([]);
  expect(f.threads.get(lead.id)?.items).toEqual([
    { type: "userMessage", content: [{ type: "text", text: "after desktop", text_elements: [] }] },
  ]);
});

test("explicit CLI resend resolves native uncertainty under the inbox lock", async () => {
  const { f, d } = await setup();
  const ref = await f.rt.create(f.spec);
  const target = `codex:${ref.id}`;
  f.admission("disconnect");
  expect(await send(d, target, "uncertain task", "operator")).toBe("HELD");
  f.admission("accept");

  await main(["inbox", "resend", target, "1"], d);
  expect(await flushInbox(d, ref)).toBe("delivered");

  expect(d.store.queued(ref)).toEqual([]);
  expect(f.threads.get(ref.id)?.items).toEqual([
    { type: "userMessage", content: [{ type: "text", text: "uncertain task", text_elements: [] }] },
  ]);
});

test("startLane creates a native Codex conversation and persists its routable lane reference", async () => {
  const { f, d } = await setup();
  const brief = `${f.root}/input.md`;
  await Bun.write(brief, "Inspect the example and return evidence.");

  const lane = await startLane(d, "native-lane", brief, { cwd: f.root });

  expect(d.store.lane("native-lane")?.sessionRef).toEqual(lane.sessionRef);
  expect(lane.sessionRef.runtime).toBe("codex");
  expect(f.threads.get(lane.sessionRef.id)?.items).toEqual([
    {
      type: "userMessage",
      content: [
        {
          type: "text",
          text: `Read your brief at ${d.store.briefPath("native-lane")} and execute it. Your lane key is native-lane.`,
          text_elements: [],
        },
      ],
    },
  ]);
});

test("terminal migration refuses Codex ownership before changing the registered role", async () => {
  const { d, lead } = await setup();
  const registered = d.store.roles().lead;

  await expect(main(["migrate", "--role", "lead", "--to", "hc"], d)).rejects.toThrow(
    "terminal migration is not supported",
  );

  expect(d.store.roles().lead).toEqual(registered);
  expect(d.store.queued(lead)).toEqual([]);
});

test("uncertain native lane startup retains a waiting lane for explicit recovery", async () => {
  const { f, d } = await setup();
  const brief = `${f.root}/uncertain.md`;
  await Bun.write(brief, "Bounded startup recovery check.");
  f.admission("disconnect");

  await expect(startLane(d, "uncertain-lane", brief, { cwd: f.root })).rejects.toMatchObject({ kind: "uncertain" });

  expect(d.store.lane("uncertain-lane")?.status).toBe("waiting");
  const ref = d.store.lane("uncertain-lane")?.sessionRef;
  if (!ref) throw new TypeError("Missing uncertain lane reference");
  expect(await f.rt.read(ref, 20)).toBe("");
  await expect(startLane(d, "uncertain-lane", brief, { cwd: f.root })).rejects.toThrow("already open");
  expect(d.store.queued(ref).map((entry) => entry.attempt?.state)).toEqual(["ambiguous"]);
  f.admission("accept");
  await main(["inbox", "resend", "uncertain-lane", "1"], d);
  expect(await flushInbox(d, ref)).toBe("delivered");
});

test("uncertain native role startup retains its role and prevents a duplicate up", async () => {
  const { f, d } = await setup();
  const store = new Store(`${f.root}/roles`);
  const rt = new CodexRuntime(store.root, f.env);
  const scoped = { ...d, store, runtimes: new Runtimes("codex", () => rt) };
  f.admission("disconnect");

  await expect(up(scoped, f.root)).rejects.toMatchObject({ kind: "uncertain" });

  expect(store.roles().lead?.runtime).toBe("codex");
  const ref = store.roles().lead;
  if (!ref) throw new TypeError("Missing uncertain lead reference");
  expect(store.queued(ref).map((entry) => entry.attempt?.state)).toEqual(["ambiguous"]);
  await expect(up(scoped, f.root)).rejects.toThrow("already registered and live");
  expect(f.threads.size).toBe(2);
});
