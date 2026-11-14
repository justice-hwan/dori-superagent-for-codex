import { expect, test } from "bun:test";
import { existsSync, type FSWatcher, mkdirSync, watch, type WatchListener, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexRuntime } from "../src/runtime/codex/index.ts";
import { CodexConnection, CodexError } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { fixture } from "./codex-fixture.test.ts";

/**
 * Models a file watcher whose OS stream is not live yet: no real watcher exists, so nothing written meanwhile can
 * ever be reported, until goLive starts the real one. Directories matching `live` start live. Only readiness
 * sentinel events are forwarded, because a newly started watcher can report a write made just before it started,
 * and such a late event must not stand in for discovery.
 */
const deadUntilLive = (live: (directory: string) => boolean = () => false) => {
  const closed: string[] = [];
  const handles: { directory: string; start: () => FSWatcher; real?: FSWatcher; closed: boolean }[] = [];
  const watchDirectory = (
    directory: string,
    options: { readonly recursive: boolean },
    listener: WatchListener<string>,
  ) => {
    const handle = {
      directory,
      start: () =>
        watch(directory, options, (event, name) => {
          if (name === ".dori-watch-ready") listener(event, name);
        }),
      closed: false,
    } as (typeof handles)[number];
    if (live(directory)) handle.real = handle.start();
    handles.push(handle);
    return {
      close: () => {
        handle.closed = true;
        closed.push(directory);
        handle.real?.close();
      },
    };
  };
  const goLive = () => {
    for (const handle of handles) if (!handle.closed && !handle.real) handle.real = handle.start();
  };
  return { watchDirectory, closed, goLive };
};

const connect = (f: Awaited<ReturnType<typeof fixture>>) => {
  const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
  f.cleanup.push(() => connection.disconnect());
  return connection;
};

test("a record written before the thread watcher is live is still discovered", async () => {
  const f = await fixture();
  const fake = deadUntilLive();
  const notify = Promise.withResolvers<SessionRef>();
  const started = watchIdle(
    new CodexStore(f.root),
    connect(f),
    async (ref) => {
      notify.resolve(ref);
    },
    fake.watchDirectory,
  );

  const ref = await new CodexRuntime(f.root, f.env).create(f.spec);
  fake.goLive();
  const stop = await started;
  try {
    expect((await notify.promise).id).toBe(ref.id);
  } finally {
    stop();
  }
});

test.each(["sessions", "inbox"] as const)("a %s watcher that never goes live fails closed", async (dead) => {
  const f = await fixture();
  const store = new CodexStore(f.root);
  const fake = deadUntilLive((directory) => !directory.endsWith(dead));

  const outcome = await watchIdle(store, connect(f), async () => undefined, fake.watchDirectory, 40).then(
    (stop) => {
      stop();
      return "ready";
    },
    (error: unknown) => (error instanceof CodexError ? error.kind : String(error)),
  );

  const sentinels = [store.directory, join(f.root, "inbox")].filter((directory) =>
    existsSync(join(directory, ".dori-watch-ready")),
  );
  console.info("WATCH_READY_FAIL_CLOSED", { dead, outcome, closed: fake.closed.length, sentinels });
  expect({ outcome, closed: fake.closed.length, sentinels }).toEqual({
    outcome: "transport",
    closed: 2,
    sentinels: [],
  });
});

test("a sentinel left by a crash is overwritten and removed without being read as a record", async () => {
  const f = await fixture();
  const store = new CodexStore(f.root);
  const directories = [store.directory, join(f.root, "inbox")];
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, ".dori-watch-ready"), "left by a crash");
  }

  const stop = await watchIdle(store, connect(f), async () => undefined);
  stop();

  const left = directories.filter((directory) => existsSync(join(directory, ".dori-watch-ready")));
  expect({ left, records: (await store.entries()).length }).toEqual({ left: [], records: 0 });
});
