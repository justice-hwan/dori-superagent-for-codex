import { expect, onTestFinished, test } from "bun:test";
import { type WatchListener, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { takeInboxLock } from "../src/inbox-lock.ts";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexConnection } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import { setup, read, count, crashDuringAdmission } from "./fixtures/codex-pending.ts";

test("duty refresh archives a crash-left pending record even when its recorded pid was reused", async () => {
  const { f, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const unrelated = Bun.spawn(["/bin/cat"], { stdin: "pipe", stdout: "ignore" });
  onTestFinished(async () => {
    unrelated.kill();
    await unrelated.exited;
  });
  writeFileSync(`${path}.submit-lock`, JSON.stringify({ pid: unrelated.pid, host: hostname(), at: Date.now() }));
  const archives = f.config.closes.length;
  const resumes = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const result = {
    closes: f.config.closes.slice(archives),
    resumes: count(f.calls, "thread/resume") - resumes,
    closed: read(path)["closed"],
  };
  console.info("CRASHED_ADMITTER_RECOVERY", result);
  expect(result).toEqual({ closes: ["thread/archive"], resumes: 0, closed: true });
});

test("duty refresh skips a pending record whose admitter still holds the thread", async () => {
  const { f, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const admitter = takeInboxLock(`${path}.submit-lock`, Date.now());
  if (!admitter) throw new TypeError("Could not hold the admission lock");
  onTestFinished(admitter);
  const archives = f.config.closes.length;
  const resumes = count(f.calls, "thread/resume");

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  stop();

  const result = {
    closes: f.config.closes.slice(archives),
    resumes: count(f.calls, "thread/resume") - resumes,
    admission: read(path)["admission"],
  };
  console.info("LIVE_ADMITTER_SKIPPED", result);
  expect(result).toEqual({ closes: [], resumes: 0, admission: "pending" });
});

test("a consistently failing recovery archive is attempted once per watcher lifetime", async () => {
  const { f, env, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  const barrier = await new CodexRuntime(home, env).create({ ...f.spec, role: "lane", name: "barrier" });
  f.config.closeMode = "fail";
  const archives = f.config.closes.length;
  // File events stay inert, so each dropped connection is the only refresh trigger. That refresh ends in one barrier
  // callback after its own resume reply reached the client, so the next drop never hits a refresh still in flight.
  const listeners: WatchListener<string>[] = [];
  const watchers = Promise.withResolvers<void>();
  const inertWatch = (
    _directory: string,
    _options: { readonly recursive: boolean },
    listener: WatchListener<string>,
  ) => {
    listeners.push(listener);
    if (listeners.length === 4) watchers.resolve();
    return { close: () => undefined };
  };
  let refreshed = Promise.withResolvers<void>();
  const startup = watchIdle(
    new CodexStore(home),
    new CodexConnection(f.env.DORI_CODEX_SOCKET),
    async (ref) => {
      if (ref.id === barrier.id) refreshed.resolve();
    },
    inertWatch,
  );
  await watchers.promise;
  for (const listener of listeners) listener("change", ".dori-watch-ready");
  const stop = await startup;
  // Stops the watcher before the fixture closes its sockets, even if this test fails first.
  f.cleanup.push(stop);
  await refreshed.promise;
  for (let refresh = 0; refresh < 3; refresh++) {
    refreshed = Promise.withResolvers<void>();
    f.dropClients();
    await refreshed.promise;
  }
  stop();
  // Any further attempt takes this lock synchronously before the barrier resumes, so it is held or already counted.
  const probe = takeInboxLock(`${path}.submit-lock`, Date.now(), { reservationAuthoritative: true });
  probe?.();
  const record = read(path);
  const result = {
    recoveryIdle: probe !== undefined,
    attempts: f.config.closes.slice(archives).filter((call) => call === "thread/archive").length,
    closed: record["closed"],
    admission: record["admission"],
    uncertain: typeof record["uncertain"],
  };
  console.info("RECOVERY_RETRIGGER", result);
  expect(result).toEqual({ recoveryIdle: true, attempts: 1, closed: false, admission: "pending", uncertain: "string" });
});

test("a pending record skipped for a live admitter is recovered after that admitter dies", async () => {
  const { f, env, home, managed } = await setup();
  const { path } = await crashDuringAdmission(f, home, () =>
    new CodexRuntime(home, managed).create({ ...f.spec, role: "lead", name: "lead" }),
  );
  await new CodexRuntime(home, env).create({ ...f.spec, role: "lane", name: "barrier" });
  const admitter = takeInboxLock(`${path}.submit-lock`, Date.now());
  if (!admitter) throw new TypeError("Could not hold the admission lock");
  const archives = f.config.closes.length;
  const archived = Promise.withResolvers<void>();
  f.config.closeObserver = (method) => {
    if (method === "thread/archive") archived.resolve();
  };

  const stop = await new CodexRuntime(home, managed).watchIdle(async () => undefined);
  f.cleanup.push(stop);
  const skipped = f.config.closes.length - archives;
  try {
    admitter();
    await archived.promise;
  } finally {
    stop();
  }

  const result = { skipped, closes: f.config.closes.slice(archives) };
  console.info("LIVE_THEN_DEAD_ADMITTER", result);
  expect(result).toEqual({ skipped: 0, closes: ["thread/archive"] });
});
