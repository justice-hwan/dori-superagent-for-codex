import { expect, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { MessageJournal } from "../src/runtime/codex/message-journal.ts";
import { MessageController, type ReconcileOutcome } from "../src/runtime/codex/messages.ts";
import { array, CodexConnection, object, text } from "../src/runtime/codex/protocol.ts";
import { CodexStore } from "../src/runtime/codex/store.ts";
import { takeManagedSubmit } from "../src/runtime/codex/submit-lock.ts";
import { watchIdle } from "../src/runtime/codex/watch.ts";
import { harnessFixture } from "./codex-fixture.test.ts";

test.each(["uncontended", "held"] as const)(
  "actual watcher delivers a source status receipt when its submit reservation is %s",
  async (mode) => {
    const { f, d } = await harnessFixture();
    const lead = await f.rt.create({ ...f.spec, role: "lead", env: {} });
    d.store.setRole("lead", lead);
    await f.rt.startAgent(lead, { prompt: "Inspect current status." });
    const source = f.finish(
      lead.id,
      JSON.stringify({ version: 1, kind: "action", tool: "dori_status", arguments: {} }),
    );
    const expectedSource = { threadId: lead.id, turnId: source.id, itemId: text(source.items.at(-1)?.["id"]) };
    const store = new CodexStore(f.root);
    const connection = new CodexConnection(f.env.DORI_CODEX_SOCKET);
    f.cleanup.push(() => connection.disconnect());
    const release = mode === "held" ? takeManagedSubmit(store, lead.id) : undefined;
    if (mode === "held" && !release) throw new Error("Missing actual source submit reservation");
    f.cleanup.push(() => release?.());
    const controller = new MessageController(d, store, connection);
    const initial = Promise.withResolvers<ReconcileOutcome>();
    const recovered = Promise.withResolvers<void>();
    const nativeRelease = Promise.withResolvers<{ filename: string; scheduled: boolean }>();
    const marker = `${lead.id}.json.submit-released`;
    let callbacks = 0;
    let ownedReads = 0;
    let releaseArmed = false;
    let releaseObserved = false;
    const owned = store.owned.bind(store);
    store.owned = (...args) => {
      if (args[0].id === lead.id) ownedReads++;
      return owned(...args);
    };
    const stop = await watchIdle(
      store,
      connection,
      async (ref, event, historical) => {
        callbacks++;
        const outcome = await controller.reconcile(ref, event, historical);
        if (callbacks === 1) initial.resolve(outcome);
        if (releaseArmed) recovered.resolve();
        return outcome;
      },
      (directory, options, listener) =>
        watch(directory, options, (event, filename) => {
          const before = ownedReads;
          listener(event, filename);
          if (releaseArmed && !releaseObserved && directory === store.directory && filename === marker) {
            releaseObserved = true;
            nativeRelease.resolve({ filename, scheduled: ownedReads > before });
          }
        }),
    );
    f.cleanup.push(stop);
    const firstOutcome = await initial.promise;
    // A read-only protocol round trip lets watchIdle settle the callback outcome; it emits no idle/file event.
    await connection.call("thread/read", { threadId: lead.id, includeTurns: false });
    let releaseEvent: { filename: string; scheduled: boolean } | undefined;
    if (release) {
      releaseArmed = true;
      release();
      releaseEvent = await nativeRelease.promise;
      // Await real recovery only if that exact native release listener scheduled it.
      // Otherwise report the missing receipt immediately rather than wait for a timeout.
      if (releaseEvent.scheduled) await recovered.promise;
    }
    stop();
    const receipts = f.requests
      .filter((frame) => frame["method"] === "turn/start" && object(frame["params"])["threadId"] === lead.id)
      .flatMap((frame) => {
        const body = array(object(frame["params"])["input"]).map(object)[0]?.["text"];
        if (typeof body !== "string" || !body.startsWith("{")) return [];
        const parsed = object(JSON.parse(body));
        return parsed["kind"] === "dori_receipt" ? [parsed] : [];
      });
    using journal = new MessageJournal(store, lead.id);
    const observation = {
      mode,
      callbacks,
      firstOutcome: firstOutcome ?? null,
      releaseEvent: releaseEvent ?? null,
      submitMetadataGone: !existsSync(`${store.path(lead.id)}.submit-lock`),
      releaseMarkerPresent: existsSync(join(store.directory, marker)),
      sourceConsumed: journal.seen(source.id),
      receipts,
    };
    console.log("SOURCE_SUBMIT_RELEASE_REPRO", JSON.stringify({ ...observation, expectedSource }));
    expect(observation).toMatchObject({
      firstOutcome: mode === "held" ? { kind: "target-busy", resource: "submit", id: lead.id } : null,
      releaseEvent: mode === "held" ? { filename: marker, scheduled: true } : null,
      submitMetadataGone: true,
      releaseMarkerPresent: true,
      sourceConsumed: true,
      receipts: [{ kind: "dori_receipt", ok: true, source: expectedSource }],
    });
  },
);
