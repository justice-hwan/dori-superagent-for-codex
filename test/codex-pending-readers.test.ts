import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { setup, records, read, count, crashDuringAdmission } from "./fixtures/codex-pending.ts";

test("the idle watcher never resumes a pending record", async () => {
  const { f, home, managed } = await setup();
  await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const before = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const resumes = count(f.calls, "thread/resume") - before;
  console.info("WATCHER_PENDING_RESUME", { resumes });
  expect(resumes).toBe(0);
});

test("probe reports a pending thread without resuming it", async () => {
  const { f, home, managed } = await setup();
  const { id } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const thread = f.threads.get(id);
  if (!thread) throw new TypeError("Missing fixture thread");
  thread.status = { type: "notLoaded" };
  const before = count(f.calls, "thread/resume");

  const probe = await new CodexRuntime(home, managed).probe({ runtime: "codex", id });

  const resumes = count(f.calls, "thread/resume") - before;
  console.info("PROBE_PENDING_RESUME", { status: probe.status, resumes });
  expect({ status: probe.status, resumes }).toEqual({ status: "unknown", resumes: 0 });
});

test("a review crash during admission leaves a pending record that delivery refuses", async () => {
  const { f, env } = await setup();
  const { path, id } = await crashDuringAdmission(f, f.root, () => new CodexRuntime(f.root, env).runReview("Late"));
  const before = count(f.calls, "turn/start");

  const delivery = await new CodexRuntime(f.root, env)
    .startAgent({ runtime: "codex", id }, { prompt: "after crash" })
    .then(
      () => "delivered",
      () => "refused",
    );

  const turns = count(f.calls, "turn/start") - before;
  const admission = read(path)["admission"];
  console.info("REVIEW_CRASH_RECORD", { admission, delivery, turns });
  expect({ admission, delivery, turns }).toEqual({ admission: "pending", delivery: "refused", turns: 0 });
});

test("a refused admission commit archives the pending thread with the refusal kept primary", async () => {
  const { f, home, managed } = await setup();
  f.config.statusObserver = () => {
    const [path] = records(home);
    if (!path) return;
    const { admission: _admission, ...changed } = read(path);
    writeFileSync(path, JSON.stringify({ ...changed, uncertain: "changed by another writer" }));
  };
  const archives = f.config.closes.length;

  const message = await new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }).then(
    () => "admitted",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

  const [path] = records(home);
  const record = path ? read(path) : {};
  console.info("COMMIT_REFUSAL_CLEANUP", {
    message,
    closes: f.config.closes.slice(archives),
    closed: record["closed"],
  });
  expect(message).toContain("changed before admission was committed");
  expect({ closes: f.config.closes.slice(archives), closed: record["closed"] }).toEqual({
    closes: ["thread/archive"],
    closed: true,
  });
});
